import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseExpectedZonePublicationMode } from "./smoke-admin-zone-publication.mjs";

const smokePath = fileURLToPath(new URL("./smoke-admin.mjs", import.meta.url));
const zoneCheckKeys = [
  "enabled",
  "automaticPublishing",
  "clock",
  "activeServing",
  "activeCurrent",
  "candidateClear",
  "legacyPromotion",
  "currentStatistics",
  "currentSnapshot",
  "historicStatistics",
  "historicClean",
  "historicCursors",
  "certifiedRun",
  "snapshotsComplete",
  "recentProgress",
];

function healthyZonePublication() {
  return {
    status: "healthy",
    serving: true,
    businessDate: "2026-08-14",
    requiredHistoricThrough: "2026-08-13",
    checks: Object.fromEntries(zoneCheckKeys.map((key) => [key, true])),
  };
}

function legacyZonePublication() {
  return {
    status: "stale",
    serving: false,
    businessDate: "2026-08-14",
    requiredHistoricThrough: "2026-08-13",
    checks: {
      enabled: false,
      automaticPublishing: false,
      clock: true,
      activeServing: false,
      activeCurrent: false,
      candidateClear: true,
      legacyPromotion: false,
      currentStatistics: true,
      currentSnapshot: false,
      historicStatistics: false,
      historicClean: false,
      historicCursors: false,
      certifiedRun: false,
      snapshotsComplete: false,
      recentProgress: true,
    },
  };
}

const healthySandreSynchronization = {
  status: "healthy",
  mode: "safe",
  requiredObservationAfter: "2026-08-01T00:00:00.000Z",
  oldestObservationAt: "2026-08-14T00:00:00.000Z",
  summary: {
    totalDepartments: 101,
    trackedDepartments: 101,
    staleDepartments: 0,
    forcedAuditCompletedDepartments: 101,
    pendingForcedAuditDepartments: 0,
    appliedDepartments: 101,
    staleAppliedDepartments: 0,
    pendingApplicationDepartments: 0,
    blockedDepartments: 0,
    failedBatches: 0,
    blockedBatches: 0,
  },
};

async function runSmoke({
  expectedMode,
  zoneStatus,
  zonePublication,
  clock = {
    status: "healthy",
    lastSeenAt: "2026-08-14T10:00:00.000Z",
    ageSeconds: 2,
    staleAfterSeconds: 120,
  },
  externalPublications = {
    status: "healthy",
    failedResourceCount: 0,
    lastRun: { status: "succeeded" },
  },
  sandreReferences = {
    status: "healthy",
    invalidReferences: {
      arreteRestrictions: 0,
      arreteCadres: 0,
      customizations: 0,
      total: 0,
    },
  },
  sandreSynchronization = healthySandreSynchronization,
}) {
  const responses = new Map([
    ["/api/health/live", { status: 200, body: { status: "ok" } }],
    [
      "/api/health/ready",
      { status: 200, body: { status: "ready", database: "up" } },
    ],
    [
      "/api/health/zone-publication",
      { status: zoneStatus, body: zonePublication },
    ],
    ["/api/health/sandre-references", { status: 200, body: sandreReferences }],
    [
      "/api/health/sandre-synchronization",
      { status: 200, body: sandreSynchronization },
    ],
    [
      "/api/health/map-archives",
      { status: 200, body: { status: "disabled", enabled: false } },
    ],
    ["/api/health/clock", { status: 200, body: clock }],
    [
      "/api/health/external-publications",
      { status: 200, body: externalPublications },
    ],
  ]);
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Admin</title>");
      return;
    }
    const configured = responses.get(url.pathname);
    if (!configured) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "not-found" }));
      return;
    }
    response.writeHead(configured.status, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify(configured.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [smokePath], {
    env: {
      ...process.env,
      VIGIEAU_ADMIN_API_URL: baseUrl,
      VIGIEAU_ADMIN_FRONT_URL: baseUrl,
      VIGIEAU_EXPECT_ZONE_PUBLICATION_MODE: expectedMode,
      VIGIEAU_SMOKE_TIMEOUT_MS: "2000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return { exitCode, stdout, stderr };
}

test("zone publication mode defaults to healthy and rejects typos", () => {
  assert.equal(parseExpectedZonePublicationMode(undefined), "healthy");
  assert.equal(parseExpectedZonePublicationMode(" legacy "), "legacy");
  assert.throws(
    () => parseExpectedZonePublicationMode("disabled"),
    /must be healthy or legacy/,
  );
});

test("admin smoke keeps the healthy zone publication contract by default", async () => {
  const result = await runSmoke({
    expectedMode: "healthy",
    zoneStatus: 200,
    zonePublication: healthyZonePublication(),
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).zonePublication.mode, "healthy");
});

test("admin smoke accepts only the explicit disabled legacy profile", async () => {
  const result = await runSmoke({
    expectedMode: "legacy",
    zoneStatus: 503,
    zonePublication: legacyZonePublication(),
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).zonePublication.mode, "legacy");
});

test("legacy mode rejects an unavailable zone publication health", async () => {
  const result = await runSmoke({
    expectedMode: "legacy",
    zoneStatus: 503,
    zonePublication: {
      ...legacyZonePublication(),
      status: "unavailable",
      checks: null,
    },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /health checks are unavailable/);
});

test("legacy mode rejects a zone publication feature left enabled", async () => {
  const zonePublication = legacyZonePublication();
  zonePublication.checks.enabled = true;
  const result = await runSmoke({
    expectedMode: "legacy",
    zoneStatus: 503,
    zonePublication,
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /enabled is unexpectedly enabled/);
});

test("legacy mode rejects stale current statistics", async () => {
  const zonePublication = legacyZonePublication();
  zonePublication.checks.currentStatistics = false;
  const result = await runSmoke({
    expectedMode: "legacy",
    zoneStatus: 503,
    zonePublication,
  });

  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /currentStatistics reports an independent failure/,
  );
});

test("legacy mode keeps the clock endpoint strict", async () => {
  const result = await runSmoke({
    expectedMode: "legacy",
    zoneStatus: 503,
    zonePublication: legacyZonePublication(),
    clock: {
      status: "stale",
      lastSeenAt: "2026-08-14T09:00:00.000Z",
      ageSeconds: 3600,
      staleAfterSeconds: 120,
    },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /clock heartbeat is not healthy/);
});

test("legacy mode keeps external publications strict", async () => {
  const result = await runSmoke({
    expectedMode: "legacy",
    zoneStatus: 503,
    zonePublication: legacyZonePublication(),
    externalPublications: {
      status: "failed",
      failedResourceCount: 1,
      lastRun: {},
    },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /external publication is failed or stale/);
});

test("legacy mode keeps SANDRE synchronization strict", async () => {
  const result = await runSmoke({
    expectedMode: "legacy",
    zoneStatus: 503,
    zonePublication: legacyZonePublication(),
    sandreSynchronization: {
      ...healthySandreSynchronization,
      status: "stale",
    },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /SANDRE synchronization is not healthy/);
});

test("legacy mode keeps disabled SANDRE references strict", async () => {
  const result = await runSmoke({
    expectedMode: "legacy",
    zoneStatus: 503,
    zonePublication: legacyZonePublication(),
    sandreReferences: {
      status: "healthy",
      invalidReferences: {
        arreteRestrictions: 0,
        arreteCadres: 1,
        customizations: 0,
        total: 1,
      },
    },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /disabled-zone references remain/);
});
