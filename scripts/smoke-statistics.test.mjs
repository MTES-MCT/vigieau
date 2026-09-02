import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { getStatisticFreshnessPolicy } from "./smoke-statistics-policy.mjs";

function dateRange(from, to) {
  const dates = [];
  const current = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

async function runSmoke({
  now,
  latestDate,
  healthStatus = 200,
  healthOverrides = {},
  healthOverridesBySample = [],
  expectArtifact = false,
  minimumInstanceCount = 2,
  truncatePublicHistory = false,
  expectedExitCode = 0,
}) {
  const policy = getStatisticFreshnessPolicy({
    now: new Date(now),
    deadline: "06:00",
  });
  const lagDays = Math.max(
    0,
    Math.round(
      (Date.parse(`${policy.expectedPublishedDate}T00:00:00Z`) -
        Date.parse(`${latestDate}T00:00:00Z`)) /
        86_400_000,
    ),
  );
  let healthRequestIndex = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const send = (body, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (url.pathname === "/api/health/live") {
      return send({ status: "ok" });
    }
    if (url.pathname === "/api/health/statistics") {
      const sampledOverrides =
        healthOverridesBySample[
          Math.min(healthRequestIndex, healthOverridesBySample.length - 1)
        ] || {};
      healthRequestIndex += 1;
      return send(
        {
          status: healthStatus === 200 ? "ready" : "degraded",
          usable: true,
          fresh: healthStatus === 200,
          currentFresh: healthStatus === 200,
          historicComplete: true,
          artifactPublicationId: null,
          artifactLiveInstances: expectArtifact ? 2 : null,
          artifactReadyInstances: expectArtifact ? 2 : null,
          mode: "legacy-bootstrap",
          currentPublishedDate: latestDate,
          expectedPublishedDate: policy.expectedPublishedDate,
          publicationDeadline: policy.deadline,
          lagDays,
          historicDirtyFrom: null,
          historicDirtyThrough: null,
          firstDate: "2013-01-01",
          latestDate,
          dateCount: 4_964,
          departmentCount: 101,
          communeCount: 34_943,
          fingerprint: "a".repeat(64),
          loadedAt: now,
          incompleteSnapshotCount: 0,
          oldestIncompleteSnapshot: null,
          lastError: null,
          ...healthOverrides,
          ...sampledOverrides,
        },
        healthStatus,
      );
    }

    const requestedStart = url.searchParams.get("dateDebut");
    const requestedEnd = url.searchParams.get("dateFin");
    const responseStart =
      truncatePublicHistory && requestedStart === "2026-01-01"
        ? "2026-01-02"
        : requestedStart;
    const responseEnd =
      requestedEnd && requestedEnd < latestDate ? requestedEnd : latestDate;
    if (url.pathname === "/api/data/departement") {
      return send(
        dateRange(responseStart, responseEnd).map((date) => ({
          date,
          departements: Array.from({ length: 101 }, (_, index) => ({
            code: String(index),
          })),
        })),
      );
    }
    if (url.pathname === "/api/data/area") {
      return send(
        dateRange(responseStart, responseEnd).map((date) => ({
          date,
          ESU: {},
          ESO: {},
          AEP: {},
        })),
      );
    }
    if (url.pathname === "/api/data/commune/65440") {
      return send({
        commune: { code: "65440" },
        restrictions: dateRange(`${requestedStart}-01`, latestDate).map(
          (date) => ({ date }),
        ),
      });
    }
    return send({ statusCode: 404 }, 404);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const child = spawn(process.execPath, ["scripts/smoke-statistics.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VIGIEAU_API_URL: `http://127.0.0.1:${server.address().port}`,
        VIGIEAU_STATISTICS_NOW: now,
        VIGIEAU_STATISTICS_DEADLINE: "06:00",
        VIGIEAU_STATISTICS_MAXIMUM_LAG_DAYS: "",
        VIGIEAU_STATISTICS_SAMPLE_COUNT: "2",
        VIGIEAU_STATISTICS_MINIMUM_INSTANCE_COUNT: String(minimumInstanceCount),
        VIGIEAU_EXPECT_STATISTIC_ARTIFACT: expectArtifact ? "true" : "false",
        VIGIEAU_CERTIFIED_HISTORY_CANARY: "disabled",
        VIGIEAU_PUBLIC_HISTORY_CANARY: "enabled",
        VIGIEAU_PUBLIC_HISTORY_CANARY_FROM: "2026-01-01",
        VIGIEAU_PUBLIC_HISTORY_CANARY_THROUGH: "2026-12-31",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const exitCode = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(exitCode, expectedExitCode, stderr || stdout);
    if (expectedExitCode !== 0) {
      return { stdout, stderr };
    }
    return JSON.parse(stdout.trim().split("\n").at(-1));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("accepts yesterday before the Paris daily deadline", async () => {
  const result = await runSmoke({
    now: "2026-08-11T03:30:00.000Z",
    latestDate: "2026-08-10",
  });
  assert.equal(result.afterDeadline, false);
  assert.equal(result.maximumLagDays, 1);
  assert.equal(result.expectedPublishedDate, "2026-08-10");
  assert.equal(result.latestDate, "2026-08-10");
  assert.deepEqual(result.publicHistoryCanary, {
    dateFrom: "2026-01-01",
    dateThrough: "2026-08-10",
    certifiedDayCount: 222,
  });
});

test("requires today after the Paris daily deadline", async () => {
  const result = await runSmoke({
    now: "2026-08-11T04:30:00.000Z",
    latestDate: "2026-08-11",
  });
  assert.equal(result.afterDeadline, true);
  assert.equal(result.maximumLagDays, 0);
  assert.equal(result.expectedPublishedDate, "2026-08-11");
  assert.equal(result.latestDate, "2026-08-11");
});

test("rejects a truncated public history shared by area and department", async () => {
  const result = await runSmoke({
    now: "2026-08-11T04:30:00.000Z",
    latestDate: "2026-08-11",
    truncatePublicHistory: true,
    expectedExitCode: 1,
  });
  assert.match(
    result.stderr,
    /Public statistics no longer start at 2026-01-01/,
  );
});

test("keeps the recovered 2026 history canary bounded after 2026", async () => {
  const result = await runSmoke({
    now: "2027-01-02T06:30:00.000Z",
    latestDate: "2027-01-02",
  });
  assert.deepEqual(result.publicHistoryCanary, {
    dateFrom: "2026-01-01",
    dateThrough: "2026-12-31",
    certifiedDayCount: 365,
  });
});

test("rejects yesterday after the Paris daily deadline", async () => {
  const result = await runSmoke({
    now: "2026-08-11T04:30:00.000Z",
    latestDate: "2026-08-10",
    expectedExitCode: 1,
  });
  assert.match(
    result.stderr,
    /Statistics stop at 2026-08-10 \(1 days behind 2026-08-11\)/,
  );
});

test("does not allow an explicit lag override after the deadline", () => {
  const policy = getStatisticFreshnessPolicy({
    now: new Date("2026-08-11T04:30:00.000Z"),
    deadline: "06:00",
    maximumLagDays: 2,
  });
  assert.equal(policy.afterDeadline, true);
  assert.equal(policy.maximumLagDays, 0);
});

test("accepts a usable 503 while an up-to-date historic rebuild is open", async () => {
  const result = await runSmoke({
    now: "2026-08-11T04:30:00.000Z",
    latestDate: "2026-08-11",
    healthStatus: 503,
    healthOverrides: {
      historicDirtyFrom: "2013-01-01",
      historicDirtyThrough: "2026-08-10",
    },
  });
  assert.equal(result.healthStatus, 503);
  assert.equal(result.degradation, "historic-rebuild");
});

test("accepts one recently active historic snapshot", async () => {
  const now = "2026-08-11T04:30:00.000Z";
  const result = await runSmoke({
    now,
    latestDate: "2026-08-11",
    healthStatus: 503,
    healthOverrides: {
      historicDirtyFrom: "2013-01-01",
      historicDirtyThrough: "2026-08-10",
      incompleteSnapshotCount: 1,
      oldestIncompleteSnapshot: {
        date: "2014-05-11",
        scope: "national",
        status: "running",
        processedCommuneCount: 17_000,
        expectedCommuneCount: 34_943,
        updatedAt: now,
      },
    },
  });
  assert.equal(result.degradation, "historic-rebuild");
});

test("accepts one recently active current snapshot", async () => {
  const now = "2026-08-11T04:30:00.000Z";
  const result = await runSmoke({
    now,
    latestDate: "2026-08-11",
    healthStatus: 503,
    healthOverrides: {
      incompleteSnapshotCount: 1,
      oldestIncompleteSnapshot: {
        date: "2026-08-11",
        scope: "national",
        status: "running",
        processedCommuneCount: 17_000,
        expectedCommuneCount: 34_943,
        updatedAt: now,
      },
    },
  });
  assert.equal(result.degradation, "current-recompute");
});

test("accepts today's running snapshot before the publication deadline", async () => {
  const now = "2026-08-11T03:30:00.000Z";
  const result = await runSmoke({
    now,
    latestDate: "2026-08-10",
    healthOverrides: {
      incompleteSnapshotCount: 1,
      oldestIncompleteSnapshot: {
        date: "2026-08-11",
        scope: "national",
        status: "running",
        processedCommuneCount: 17_000,
        expectedCommuneCount: 34_943,
        updatedAt: now,
      },
    },
  });
  assert.equal(result.healthStatus, 200);
  assert.equal(result.latestDate, "2026-08-10");
});

test("accepts a recent ready snapshot during atomic finalization", async () => {
  const now = "2026-08-11T04:30:00.000Z";
  const result = await runSmoke({
    now,
    latestDate: "2026-08-11",
    healthOverrides: {
      incompleteSnapshotCount: 1,
      oldestIncompleteSnapshot: {
        date: "2026-08-11",
        scope: "national",
        status: "ready",
        processedCommuneCount: 34_943,
        expectedCommuneCount: 34_943,
        updatedAt: now,
      },
    },
  });
  assert.equal(result.healthStatus, 200);
});

test("does not count two loads from one public API instance as a quorum", async () => {
  const result = await runSmoke({
    now: "2026-08-11T04:30:00.000Z",
    latestDate: "2026-08-11",
    expectArtifact: true,
    healthOverrides: {
      artifactPublicationId: "2a71d0ae-6526-4a65-a497-c503b2ffe023",
      artifactLiveInstances: 1,
      artifactReadyInstances: 1,
    },
    healthOverridesBySample: [
      { loadedAt: "2026-08-11T04:29:00.000Z" },
      { loadedAt: "2026-08-11T04:30:00.000Z" },
    ],
    expectedExitCode: 1,
  });
  assert.match(
    result.stderr,
    /live instance count must be an integer greater than or equal to 2/i,
  );
});

test("rejects a live public API instance that has not acknowledged the artifact", async () => {
  const result = await runSmoke({
    now: "2026-08-11T04:30:00.000Z",
    latestDate: "2026-08-11",
    expectArtifact: true,
    healthOverrides: {
      artifactPublicationId: "2a71d0ae-6526-4a65-a497-c503b2ffe023",
      artifactLiveInstances: 2,
      artifactReadyInstances: 1,
    },
    minimumInstanceCount: 1,
    expectedExitCode: 1,
  });
  assert.match(result.stderr, /not every live public API instance/i);
});

test("accepts progress differences between consecutive samples", async () => {
  const now = "2026-08-11T04:30:00.000Z";
  const baseSnapshot = {
    date: "2014-05-11",
    scope: "national",
    status: "running",
    expectedCommuneCount: 34_943,
  };
  const result = await runSmoke({
    now,
    latestDate: "2026-08-11",
    healthStatus: 503,
    healthOverrides: {
      historicDirtyFrom: "2013-01-01",
      historicDirtyThrough: "2026-08-10",
    },
    healthOverridesBySample: [
      {
        incompleteSnapshotCount: 1,
        oldestIncompleteSnapshot: {
          ...baseSnapshot,
          processedCommuneCount: 1_000,
          updatedAt: "2026-08-11T04:29:00.000Z",
        },
      },
      {
        incompleteSnapshotCount: 1,
        oldestIncompleteSnapshot: {
          ...baseSnapshot,
          processedCommuneCount: 20_000,
          updatedAt: now,
        },
      },
    ],
  });
  assert.equal(result.healthStatus, 503);
});

test("accepts a running snapshot completing between samples", async () => {
  const now = "2026-08-11T04:30:00.000Z";
  const result = await runSmoke({
    now,
    latestDate: "2026-08-11",
    healthStatus: 503,
    healthOverrides: {
      historicDirtyFrom: "2013-01-01",
      historicDirtyThrough: "2026-08-10",
    },
    healthOverridesBySample: [
      {
        incompleteSnapshotCount: 1,
        oldestIncompleteSnapshot: {
          date: "2014-05-11",
          scope: "national",
          status: "running",
          processedCommuneCount: 34_000,
          expectedCommuneCount: 34_943,
          updatedAt: now,
        },
      },
      { incompleteSnapshotCount: 0, oldestIncompleteSnapshot: null },
    ],
  });
  assert.equal(result.healthStatus, 503);
});

test("rejects a fingerprint divergence between samples", async () => {
  const result = await runSmoke({
    now: "2026-08-11T04:30:00.000Z",
    latestDate: "2026-08-11",
    healthOverridesBySample: [
      { fingerprint: "a".repeat(64) },
      { fingerprint: "b".repeat(64) },
    ],
    expectedExitCode: 1,
  });
  assert.match(result.stderr, /field fingerprint differs/i);
});

test("requires one current immutable artifact on every sampled instance", async () => {
  const artifactPublicationId = "2a71d0ae-6526-4a65-a497-c503b2ffe023";
  const result = await runSmoke({
    now: "2026-08-11T04:30:00.000Z",
    latestDate: "2026-08-11",
    expectArtifact: true,
    healthOverrides: {
      artifactPublicationId,
      currentFresh: true,
      historicComplete: false,
      historicDirtyFrom: "2013-01-01",
      historicDirtyThrough: "2026-08-10",
    },
  });
  assert.equal(result.healthStatus, 200);
  assert.equal(result.liveInstanceCount, 2);
  assert.equal(result.readyInstanceCount, 2);
});

test("rejects a missing immutable artifact when production requires it", async () => {
  const result = await runSmoke({
    now: "2026-08-11T04:30:00.000Z",
    latestDate: "2026-08-11",
    expectArtifact: true,
    expectedExitCode: 1,
  });
  assert.match(result.stderr, /artifact publication id is missing or invalid/i);
});

test("rejects an immutable artifact identity divergence between instances", async () => {
  const result = await runSmoke({
    now: "2026-08-11T04:30:00.000Z",
    latestDate: "2026-08-11",
    expectArtifact: true,
    healthOverridesBySample: [
      {
        artifactPublicationId: "2a71d0ae-6526-4a65-a497-c503b2ffe023",
      },
      {
        artifactPublicationId: "598b0532-1ed6-45a0-841a-b40f1860b2d2",
      },
    ],
    expectedExitCode: 1,
  });
  assert.match(result.stderr, /field artifactPublicationId differs/i);
});

test("rejects a degraded response when an immutable artifact is required", async () => {
  const result = await runSmoke({
    now: "2026-08-11T04:30:00.000Z",
    latestDate: "2026-08-11",
    healthStatus: 503,
    expectArtifact: true,
    healthOverrides: {
      artifactPublicationId: "2a71d0ae-6526-4a65-a497-c503b2ffe023",
      currentFresh: false,
      historicComplete: false,
      historicDirtyFrom: "2013-01-01",
      historicDirtyThrough: "2026-08-10",
    },
    expectedExitCode: 1,
  });
  assert.match(result.stderr, /immutable statistics artifact is not current/i);
});

test("rejects a cache error hidden behind an historic rebuild", async () => {
  const result = await runSmoke({
    now: "2026-08-11T04:30:00.000Z",
    latestDate: "2026-08-11",
    healthStatus: 503,
    healthOverrides: {
      historicDirtyFrom: "2013-01-01",
      historicDirtyThrough: "2026-08-10",
      lastError: {
        at: "2026-08-11T04:29:00.000Z",
        phase: "cache-refresh",
      },
    },
    expectedExitCode: 1,
  });
  assert.match(result.stderr, /statistics cache reports an error/i);
});

test("rejects a 503 without a healthy historic rebuild", async () => {
  const result = await runSmoke({
    now: "2026-08-11T04:30:00.000Z",
    latestDate: "2026-08-11",
    healthStatus: 503,
    expectedExitCode: 1,
  });
  assert.match(result.stderr, /Unexpected statistics degradation/);
});

test("rejects a failed historic snapshot", async () => {
  const result = await runSmoke({
    now: "2026-08-11T04:30:00.000Z",
    latestDate: "2026-08-11",
    healthStatus: 503,
    healthOverrides: {
      historicDirtyFrom: "2013-01-01",
      historicDirtyThrough: "2026-08-10",
      incompleteSnapshotCount: 1,
      oldestIncompleteSnapshot: {
        date: "2014-05-11",
        scope: "national",
        status: "failed",
        processedCommuneCount: 34_943,
        expectedCommuneCount: 34_943,
        updatedAt: "2026-08-11T04:29:00.000Z",
      },
    },
    expectedExitCode: 1,
  });
  assert.match(result.stderr, /unhealthy incomplete snapshot/);
});

test("rejects a stale running historic snapshot", async () => {
  const result = await runSmoke({
    now: "2026-08-11T04:30:00.000Z",
    latestDate: "2026-08-11",
    healthStatus: 503,
    healthOverrides: {
      historicDirtyFrom: "2013-01-01",
      historicDirtyThrough: "2026-08-10",
      incompleteSnapshotCount: 1,
      oldestIncompleteSnapshot: {
        date: "2014-05-11",
        scope: "national",
        status: "running",
        processedCommuneCount: 17_000,
        expectedCommuneCount: 34_943,
        updatedAt: "2026-08-11T04:00:00.000Z",
      },
    },
    expectedExitCode: 1,
  });
  assert.match(result.stderr, /unhealthy incomplete snapshot/);
});

test("rejects multiple incomplete historic snapshots", async () => {
  const result = await runSmoke({
    now: "2026-08-11T04:30:00.000Z",
    latestDate: "2026-08-11",
    healthStatus: 503,
    healthOverrides: {
      historicDirtyFrom: "2013-01-01",
      historicDirtyThrough: "2026-08-10",
      incompleteSnapshotCount: 2,
      oldestIncompleteSnapshot: {
        date: "2014-05-11",
        scope: "national",
        status: "running",
        processedCommuneCount: 17_000,
        expectedCommuneCount: 34_943,
        updatedAt: "2026-08-11T04:29:00.000Z",
      },
    },
    expectedExitCode: 1,
  });
  assert.match(result.stderr, /unhealthy incomplete snapshot/);
});

test("rejects an unusable 503 even when public data is still readable", async () => {
  const result = await runSmoke({
    now: "2026-08-11T04:30:00.000Z",
    latestDate: "2026-08-11",
    healthStatus: 503,
    healthOverrides: {
      status: "unavailable",
      usable: false,
    },
    expectedExitCode: 1,
  });
  assert.match(result.stderr, /The statistics cache is not usable/);
});
