import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  configureClamd,
  configureClamavFile,
  configureClamavProfile,
  configureClamavBuild,
  CLAMAV_BUILDPACK,
} from "../apps/backend-admin/scripts/configure-clamav.mjs";
import {
  DOCUMENT_SCAN_CANCEL_GRACE_MS,
  runDocumentScan,
} from "../apps/backend-admin/scripts/run-document-scan.mjs";
import { setTimeout as delay } from "node:timers/promises";

const buildpackConfig =
  "DatabaseDirectory /app/clamav/data\nLocalSocket /app/clamav/run/clamd.sock\nForeground no\n";
const directives = (config) =>
  Object.fromEntries(
    config
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/)),
  );

const officialProfile = `CLAMAV_START=0
current_process_type="$( echo "\${CONTAINER}" | rev | cut -d'-' -f2- | rev )"
IFS=', ' read -r -a disabled <<< "\${CLAMAV_DISABLE_PROCESS_TYPES:-"postdeploy,one-off"}"
for p in "\${disabled[@]}"; do
  if [ "\${p}" == "\${current_process_type}" ]; then
    CLAMAV_START=1
    break
  fi
done
export CLAMAV_START
`;

test("the pinned profile selects web and excludes workers and one-offs without rev or cut", () => {
  const profile = configureClamavProfile(officialProfile);
  assert.equal(configureClamavProfile(profile), profile);
  assert.throws(
    () => configureClamavProfile("unexpected upstream profile"),
    /Unexpected/,
  );
  for (const [container, expected] of [
    ["web-1", "0"],
    ["clock-1", "1"],
    ["currentzoneworker-1", "1"],
    ["one-off-123", "1"],
  ]) {
    const output = execFileSync(
      "/bin/bash",
      ["-c", `${profile}\nprintf '%s' "$CLAMAV_START"`],
      {
        encoding: "utf8",
        env: {
          PATH: "/nonexistent",
          CONTAINER: container,
          CLAMAV_DISABLE_PROCESS_TYPES:
            "clock,currentzoneworker,postdeploy,one-off",
        },
      },
    );
    assert.equal(output, expected, container);
  }
});

test("postbuild checks the pin and patches the buildpack profile before runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vigieau-clamav-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "clamav/conf"), { recursive: true });
  await mkdir(join(root, ".profile.d"));
  await writeFile(join(root, ".buildpacks"), `${CLAMAV_BUILDPACK}\n`);
  await writeFile(join(root, "clamav/conf/clamd.conf"), buildpackConfig);
  await writeFile(join(root, ".profile.d/010-clamav.sh"), officialProfile);
  await configureClamavBuild(root);
  assert.equal(
    await readFile(join(root, ".profile.d/010-clamav.sh"), "utf8"),
    configureClamavProfile(officialProfile),
  );
  await writeFile(
    join(root, ".buildpacks"),
    "https://github.com/Scalingo/clamav-buildpack.git#unknown\n",
  );
  await assert.rejects(
    configureClamavBuild(root),
    /Unexpected ClamAV buildpack pin/,
  );
});

test("the built configuration rejects unscannable documents and bounds resource usage without adding TCP", () => {
  const result = configureClamd(
    `${buildpackConfig}MaxScanTime 999999\nMaxScanTime 50000\nAlertEncrypted no\n`,
  );
  const values = directives(result);
  assert.equal(values.DatabaseDirectory, "/app/clamav/data");
  assert.equal(values.LocalSocket, "/app/clamav/run/clamd.sock");
  assert.equal(values.StreamMaxLength, "32M");
  assert.equal(values.MaxFileSize, "32M");
  assert.equal(values.MaxScanSize, "128M");
  assert.equal(values.AlertExceedsMax, "yes");
  assert.equal(values.AlertEncrypted, "yes");
  assert.equal(values.ConcurrentDatabaseReload, "yes");
  assert.equal(values.MaxScanTime, "10000");
  assert.equal(Number(values.MaxQueue), Number(values.MaxThreads) * 2);
  assert.equal((result.match(/^MaxScanTime /gm) || []).length, 1);
  assert.equal(configureClamd(result), result);
  assert.equal(values.TCPSocket, undefined);
});

test("missing buildpack configuration and TCP configuration fail the build", () => {
  assert.throws(() => configureClamd(""), /DatabaseDirectory/);
  assert.throws(
    () => configureClamd("DatabaseDirectory /tmp/db\n"),
    /LocalSocket/,
  );
  assert.throws(
    () => configureClamd(`${buildpackConfig}TCPSocket 3310\n`),
    /without a TCP listener/,
  );
});

test("the postbuild works outside /app and the batch changes only its private copy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vigieau-clamav-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "clamd.conf");
  await writeFile(configPath, buildpackConfig);
  await configureClamavFile(configPath);
  const webConfig = await readFile(configPath, "utf8");
  const batch = directives(
    configureClamd(webConfig, { batch: true, socket: "/tmp/batch.sock" }),
  );
  assert.equal(batch.MaxScanTime, "60000");
  assert.equal(batch.LocalSocket, "/tmp/batch.sock");
  assert.equal(batch.AlertExceedsMax, "yes");
  assert.equal(batch.AlertEncrypted, "yes");
  assert.equal(await readFile(configPath, "utf8"), webConfig);
});

async function prepareBatch(
  t,
  {
    updateFails = false,
    waitForCancellation = false,
    ignoreCancellation = false,
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "vigieau-clamav-batch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [
    "clamav/conf",
    "clamav/bin",
    "clamav/sbin",
    "dist/apps/backend-admin/src/scripts",
  ]) {
    await mkdir(join(root, path), { recursive: true });
  }
  await writeFile(
    join(root, "clamav/conf/clamd.conf"),
    configureClamd(buildpackConfig),
  );
  await writeFile(
    join(root, "clamav/conf/freshclam.conf"),
    "DatabaseDirectory /app/clamav/data\nNotifyClamd /app/clamav/conf/clamd.conf\n",
  );
  const record = join(root, "order.jsonl");
  const recordCode = `const record = (value) => fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(value) + '\\n');`;
  const executable = (path, content) =>
    writeFile(join(root, path), `#!${process.execPath}\n${content}`, {
      mode: 0o700,
    });
  await executable(
    "clamav/bin/freshclam",
    `
const fs = require('node:fs');
${recordCode}
const conf = process.argv.find((arg) => arg.startsWith('--config-file=')).split('=').slice(1).join('=');
if (fs.readFileSync(conf, 'utf8').includes('NotifyClamd')) process.exit(90);
record({ stage: 'freshclam' });
process.exit(${updateFails ? 1 : 0});
`,
  );
  await executable(
    "clamav/sbin/clamd",
    `
const fs = require('node:fs');
const net = require('node:net');
${recordCode}
const conf = process.argv.find((arg) => arg.startsWith('--config-file=')).split('=').slice(1).join('=');
const socket = fs.readFileSync(conf, 'utf8').match(/^LocalSocket (.+)$/m)[1];
const server = net.createServer((connection) => connection.on('data', () => connection.end('PONG\\0')));
server.listen(socket, () => record({ stage: 'clamd' }));
process.on('SIGTERM', () => { record({ stage: 'stopped' }); server.close(() => process.exit(0)); });
`,
  );
  await writeFile(
    join(root, "dist/apps/backend-admin/src/scripts/scan-documents.js"),
    `
const fs = require('node:fs');
${recordCode}
record({ stage: 'scan', args: process.argv.slice(2), config: process.env.CLAMD_CONFIG_FILE,
  enabled: process.env.ANTIVIRUS_ENABLED, timeout: process.env.ANTIVIRUS_TIMEOUT_MS,
  clamdscan: process.env.CLAMDSCAN_PATH, contents: fs.readFileSync(process.env.CLAMD_CONFIG_FILE, 'utf8') });
if (${waitForCancellation}) {
  const hold = setInterval(() => {}, 1000);
  process.on('SIGTERM', () => {
    record({ stage: 'sigterm' });
    if (!${ignoreCancellation}) setTimeout(() => {
      record({ stage: 'quarantine_finished' });
      clearInterval(hold);
      process.exit(0);
    }, 40);
  });
}
`,
  );
  return {
    root,
    record,
    env: { ...process.env, CONTAINER: "one-off-123", CLAMAV_START: "1" },
  };
}

test("the batch refreshes first, starts a private daemon, passes arguments and cleans up", async (t) => {
  const { root, record, env } = await prepareBatch(t);
  const original = await readFile(join(root, "clamav/conf/clamd.conf"), "utf8");
  assert.equal(
    await runDocumentScan({
      appRoot: root,
      args: ["--execute", "--prefix=a b/"],
      env,
    }),
    0,
  );
  const events = (await readFile(record, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    events.map((event) => event.stage),
    ["freshclam", "clamd", "scan", "stopped"],
  );
  const scan = events[2];
  assert.deepEqual(scan.args, ["--execute", "--prefix=a b/"]);
  assert.equal(scan.enabled, "true");
  assert.equal(scan.timeout, "75000");
  assert.equal(scan.clamdscan, join(root, "clamav/bin/clamdscan"));
  assert.equal(directives(scan.contents).MaxScanTime, "60000");
  assert.equal(
    await readFile(join(root, "clamav/conf/clamd.conf"), "utf8"),
    original,
  );
  await assert.rejects(readFile(scan.config), { code: "ENOENT" });
});

async function waitForScanner(record) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(record, "utf8")).includes('"stage":"scan"')) return;
    } catch {
      /* The signature updater may not have started yet. */
    }
    await delay(5);
  }
  throw new Error("Fixture scanner did not start");
}

test("cancellation sends one SIGTERM and waits for confirmed quarantine before daemon cleanup", async (t) => {
  assert.equal(DOCUMENT_SCAN_CANCEL_GRACE_MS, 210000);
  const { root, record, env } = await prepareBatch(t, {
    waitForCancellation: true,
  });
  const controller = new AbortController();
  const running = runDocumentScan({
    appRoot: root,
    args: ["--execute"],
    env,
    signal: controller.signal,
    cancellationGraceMs: 500,
  });
  await waitForScanner(record);
  controller.abort();
  assert.equal(await running, 1);
  const events = (await readFile(record, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    events.map((event) => event.stage),
    ["freshclam", "clamd", "scan", "sigterm", "quarantine_finished", "stopped"],
  );
});

test("a scanner ignoring cancellation is forcibly stopped when the bounded grace expires", async (t) => {
  const { root, record, env } = await prepareBatch(t, {
    waitForCancellation: true,
    ignoreCancellation: true,
  });
  const controller = new AbortController();
  const running = runDocumentScan({
    appRoot: root,
    args: ["--execute"],
    env,
    signal: controller.signal,
    cancellationGraceMs: 40,
  });
  await waitForScanner(record);
  controller.abort();
  assert.equal(await running, 1);
  const events = (await readFile(record, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    events.map((event) => event.stage),
    ["freshclam", "clamd", "scan", "sigterm", "stopped"],
  );
});

test("a failed signature update aborts before starting the scan", async (t) => {
  const { root, record, env } = await prepareBatch(t, { updateFails: true });
  await assert.rejects(
    runDocumentScan({ appRoot: root, args: ["--execute"], env }),
    /Command failed/,
  );
  assert.deepEqual(
    (await readFile(record, "utf8")).trim().split("\n").map(JSON.parse),
    [{ stage: "freshclam" }],
  );
});

test("inventory does not need the ClamAV binaries and propagates the command exit code", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vigieau-clamav-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist/apps/backend-admin/src/scripts"), {
    recursive: true,
  });
  await writeFile(
    join(root, "dist/apps/backend-admin/src/scripts/scan-documents.js"),
    "process.exit(7);\n",
  );
  assert.equal(
    await runDocumentScan({
      appRoot: root,
      args: ["--dry-run"],
      env: { CONTAINER: "one-off-1", CLAMAV_START: "1" },
    }),
    7,
  );
});

test("the batch cannot run inside a web container or duplicate an automatically started daemon", async () => {
  await assert.rejects(
    runDocumentScan({ env: { CONTAINER: "web-1" } }),
    /dedicated one-off/,
  );
  await assert.rejects(
    runDocumentScan({ env: { CONTAINER: "one-off-123", CLAMAV_START: "0" } }),
    /Exclude one-off/,
  );
});
