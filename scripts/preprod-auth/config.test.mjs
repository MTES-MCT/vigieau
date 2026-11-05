import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  APP_NAMES,
  GATEWAY_VERSION,
  profile,
  gatewayConfiguration,
} from "./config.mjs";

const salt = Buffer.alloc(16, 1);
const hash = `scrypt$16384$8$1$${salt.toString("base64url")}$${scryptSync("synthetic-password", salt, 64, { N: 16384, r: 8, p: 1 }).toString("base64url")}`;
const settings = (role = "frontend") => ({
  APP: APP_NAMES[role],
  PORT: "5000",
  VIGIEAU_PREPROD_AUTH_ENABLED: "true",
  VIGIEAU_PREPROD_AUTH_USERNAME: "synthetic-tester",
  VIGIEAU_PREPROD_AUTH_PASSWORD_HASH: hash,
  VIGIEAU_PREPROD_AUTH_SESSION_SECRET: Buffer.alloc(32, 1).toString(
    "base64url",
  ),
});

test("only the exact public preproduction applications can activate the native gateway", () => {
  for (const role of ["frontend", "backend"]) {
    for (const flag of [undefined, "", "false"])
      assert.deepEqual(profile({ VIGIEAU_PREPROD_AUTH_ENABLED: flag }, role), {
        enabled: false,
      });
    assert.deepEqual(profile(settings(role), role), { enabled: true });
    for (const APP of [
      "",
      "preservonsleau-front-prod",
      "vigieau-api",
      "regleau-front-preprod",
    ])
      assert.throws(() => profile({ ...settings(role), APP }, role));
    for (const flag of ["1", "TRUE", "False", " true "])
      assert.throws(() =>
        profile({ VIGIEAU_PREPROD_AUTH_ENABLED: flag }, role),
      );
  }
  assert.throws(() => profile({}, "worker"));
});

test("configuration validates fixed scrypt cost, canonical keys and listening port", () => {
  const config = gatewayConfiguration(settings(), "frontend");
  assert.equal(config.upstream, "http://127.0.0.1:8080");
  assert.equal(config.password.salt.length, 16);
  assert.equal(config.password.digest.length, 64);
  assert.equal(config.sessionSecret.length, 32);
  for (const key of [
    "VIGIEAU_PREPROD_AUTH_USERNAME",
    "VIGIEAU_PREPROD_AUTH_PASSWORD_HASH",
    "VIGIEAU_PREPROD_AUTH_SESSION_SECRET",
  ]) {
    for (const value of [undefined, ""])
      assert.throws(() =>
        gatewayConfiguration({ ...settings(), [key]: value }, "frontend"),
      );
  }
  for (const value of [
    hash.replace("16384", "1048576"),
    hash.replace("$8$", "$1$"),
    `${hash}\n`,
    `${hash}=`,
    hash.replace(
      salt.toString("base64url"),
      Buffer.alloc(15).toString("base64url"),
    ),
  ]) {
    assert.throws(() =>
      gatewayConfiguration(
        { ...settings(), VIGIEAU_PREPROD_AUTH_PASSWORD_HASH: value },
        "frontend",
      ),
    );
  }
  for (const value of [
    "a".repeat(32),
    `${settings().VIGIEAU_PREPROD_AUTH_SESSION_SECRET}=`,
    Buffer.alloc(31).toString("base64url"),
    `${settings().VIGIEAU_PREPROD_AUTH_SESSION_SECRET}\n`,
  ]) {
    assert.throws(() =>
      gatewayConfiguration(
        { ...settings(), VIGIEAU_PREPROD_AUTH_SESSION_SECRET: value },
        "frontend",
      ),
    );
  }
  for (const PORT of [
    undefined,
    "",
    "0",
    "8080",
    "08080",
    "65536",
    "1x",
    "5000\n",
  ])
    assert.throws(() =>
      gatewayConfiguration({ ...settings(), PORT }, "frontend"),
    );
});

test("credential changes revoke the version shared across frontend and API", () => {
  const front = gatewayConfiguration(settings(), "frontend");
  const api = gatewayConfiguration(settings("backend"), "backend");
  assert.equal(front.credentialVersion, api.credentialVersion);
  assert.notEqual(
    front.credentialVersion,
    gatewayConfiguration(
      { ...settings(), VIGIEAU_PREPROD_AUTH_USERNAME: "replacement" },
      "frontend",
    ).credentialVersion,
  );
  assert.notEqual(
    front.credentialVersion,
    gatewayConfiguration(
      {
        ...settings(),
        VIGIEAU_PREPROD_AUTH_PASSWORD_HASH: hash.replace(
          salt.toString("base64url"),
          randomBytes(16).toString("base64url"),
        ),
      },
      "frontend",
    ).credentialVersion,
  );
});

test("installation is offline and startup rejects an unrecompiled mode or missing credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vigieau-native-config-"));
  try {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/preprod-auth/install.mjs"), "backend"],
      { cwd: directory, env: { PATH: process.env.PATH }, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(
        await readFile(join(directory, ".preprod-auth/build.json"), "utf8"),
      ),
      { enabled: false, version: GATEWAY_VERSION },
    );
    assert.match(
      await readFile(join(directory, ".preprod-auth/gateway.mjs"), "utf8"),
      /createGateway/,
    );
    const launch = spawnSync(
      process.execPath,
      [join(directory, ".preprod-auth/launch.mjs")],
      {
        cwd: directory,
        env: { ...settings("backend"), PATH: process.env.PATH },
        encoding: "utf8",
      },
    );
    assert.equal(launch.status, 1);
    assert.match(launch.stderr, /rebuild the application/);
    const enabled = spawnSync(
      process.execPath,
      [resolve("scripts/preprod-auth/install.mjs"), "backend"],
      {
        cwd: directory,
        env: {
          APP: APP_NAMES.backend,
          VIGIEAU_PREPROD_AUTH_ENABLED: "true",
          PATH: process.env.PATH,
        },
        encoding: "utf8",
      },
    );
    assert.equal(enabled.status, 0, enabled.stderr);
    const missing = spawnSync(
      process.execPath,
      [join(directory, ".preprod-auth/launch.mjs")],
      {
        cwd: directory,
        env: {
          APP: APP_NAMES.backend,
          VIGIEAU_PREPROD_AUTH_ENABLED: "true",
          PATH: process.env.PATH,
        },
        encoding: "utf8",
      },
    );
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /USERNAME/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await delay(20);
    }
  }
  throw new Error(`Fixture did not become ready: ${path}`);
}
async function dead(pid) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      if (/\) Z /.test(stat)) return true;
    } catch {
      return true;
    }
    await delay(20);
  }
  return false;
}

test("supervisor stops both process groups and stubborn descendants on SIGTERM or child failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vigieau-native-supervisor-"));
  const launcher = new URL("./launch.mjs", import.meta.url).href;
  const tracked = [];
  try {
    const grandchild = join(directory, "grandchild.mjs");
    const child = join(directory, "child.mjs");
    await writeFile(
      grandchild,
      "import { writeFileSync } from 'node:fs'; process.on('SIGTERM',()=>{}); writeFileSync(process.argv[2],String(process.pid)); setInterval(()=>{},1000);\n",
    );
    await writeFile(
      child,
      "import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:'ignore'}); writeFileSync(process.argv[4],String(process.pid)); setInterval(()=>{},1000);\n",
    );
    for (const trigger of ["signal", "failure"]) {
      const files = [0, 1].map((index) => ({
        parent: join(directory, `${trigger}-${index}.pid`),
        nested: join(directory, `${trigger}-${index}-nested.pid`),
      }));
      const commands = files.map((paths) => ({
        command: process.execPath,
        args: [child, grandchild, paths.nested, paths.parent],
      }));
      const entry = join(directory, `${trigger}.mjs`);
      await writeFile(
        entry,
        `import { superviseProcesses } from ${JSON.stringify(launcher)}; process.exitCode=await superviseProcesses(${JSON.stringify(commands)},{graceMs:150});\n`,
      );
      const supervisor = spawn(process.execPath, [entry], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      tracked.push(supervisor);
      let error = "";
      supervisor.stderr.on("data", (data) => (error += data));
      const pids = [];
      for (const paths of files)
        pids.push(
          Number(await waitForFile(paths.parent)),
          Number(await waitForFile(paths.nested)),
        );
      const completed = new Promise((resolve) =>
        supervisor.once("exit", resolve),
      );
      if (trigger === "signal") supervisor.kill("SIGTERM");
      else process.kill(pids[0], "SIGKILL");
      const code = await Promise.race([
        completed,
        delay(5000, undefined, { ref: false }).then(() => {
          throw new Error("Supervisor did not exit");
        }),
      ]);
      assert.equal(code, trigger === "signal" ? 0 : 1, error);
      for (const pid of pids)
        assert.ok(await dead(pid), `Descendant ${pid} survived ${trigger}`);
    }
  } finally {
    for (const child of tracked)
      if (child.exitCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});
