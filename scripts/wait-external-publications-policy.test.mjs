import assert from "node:assert/strict";
import test from "node:test";
import { classifyExternalPublicationConvergence } from "./wait-external-publications-policy.mjs";

const ready = {
  status: "healthy",
  failedResourceCount: 0,
  networkRetry: null,
  lastRun: { scheduledFor: "2026-08-31", status: "succeeded" },
  historicExport: {
    status: "ready",
    scheduledFor: "2026-08-31",
    blockingAgeSeconds: 0,
  },
};

test("accepts a current successful external publication", () => {
  assert.deepEqual(classifyExternalPublicationConvergence(ready), {
    state: "stable",
    reason: null,
  });
});

test("waits when today's export is ready but the latest success is yesterday's", () => {
  assert.deepEqual(
    classifyExternalPublicationConvergence({
      ...ready,
      lastRun: { scheduledFor: "2026-08-30", status: "succeeded" },
    }),
    { state: "updating", reason: "daily_publication_pending" },
  );
});

test("waits while today's publication is running", () => {
  assert.deepEqual(
    classifyExternalPublicationConvergence({
      ...ready,
      status: "degraded",
      lastRun: { scheduledFor: "2026-08-31", status: "running" },
    }),
    { state: "updating", reason: "daily_publication_pending" },
  );
});

test("waits for a recent, explicitly transient publication boundary", () => {
  assert.deepEqual(
    classifyExternalPublicationConvergence({
      ...ready,
      status: "stale",
      historicExport: {
        status: "blocked",
        blocker: "zone_publication_promotion_retry",
        blockingAgeSeconds: 900,
      },
    }),
    { state: "updating", reason: "zone_publication_promotion_retry" },
  );
});

test("rejects semantic historic coverage failures immediately", () => {
  assert.deepEqual(
    classifyExternalPublicationConvergence({
      ...ready,
      status: "stale",
      historicExport: {
        status: "blocked",
        blocker: "sparse_statistic_cache",
        blockingAgeSeconds: 30,
      },
    }),
    { state: "blocked", reason: "sparse_statistic_cache" },
  );
});

test("does not tolerate a transient blocker beyond its SLA", () => {
  assert.deepEqual(
    classifyExternalPublicationConvergence(
      {
        ...ready,
        status: "stale",
        historicExport: {
          status: "blocked",
          blocker: "statistic_cache_quorum_incomplete",
          blockingAgeSeconds: 3_601,
        },
      },
      { maximumBlockingAgeSeconds: 3_600 },
    ),
    { state: "blocked", reason: "statistic_cache_quorum_incomplete" },
  );
});

test("waits for an idempotent network retry", () => {
  assert.deepEqual(
    classifyExternalPublicationConvergence({
      ...ready,
      status: "degraded",
      networkRetry: { status: "network_retry", resourceKeys: ["geojson"] },
    }),
    { state: "updating", reason: "network_retry" },
  );
});

test("does not let a network retry hide a semantic historic failure", () => {
  const body = structuredClone(ready);
  body.networkRetry = {
    status: "network_retry",
    resourceKeys: ["statistiques"],
    lastFailureAt: "2026-08-31T06:05:00.000Z",
    failureAgeSeconds: 30,
    retryAfter: "2026-08-31T06:06:00.000Z",
  };
  body.historicExport = {
    status: "blocked",
    scheduledFor: "2026-08-30",
    observedAt: "2026-08-31T06:05:30.000Z",
    blockingSince: "2026-08-31T06:00:00.000Z",
    blockingAgeSeconds: 330,
    blocker: "sparse_statistic_cache",
  };

  assert.deepEqual(classifyExternalPublicationConvergence(body), {
    state: "blocked",
    reason: "sparse_statistic_cache",
  });
});
