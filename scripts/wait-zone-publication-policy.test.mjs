import assert from "node:assert/strict";
import test from "node:test";
import { classifyZonePublicationConvergence } from "./wait-zone-publication-policy.mjs";

const healthyChecks = {
  enabled: true,
  automaticPublishing: true,
  clock: true,
  activeServing: true,
  activeCurrent: true,
  candidateClear: true,
  legacyPromotion: true,
  currentStatistics: true,
  currentSnapshot: true,
  certifiedRun: true,
  recentProgress: true,
};

test("accepts a stable publication without requiring complete historic cursors", () => {
  assert.deepEqual(
    classifyZonePublicationConvergence({
      status: "healthy",
      historicStatus: "incomplete",
      serving: true,
      checks: { ...healthyChecks, historicClean: false },
    }),
    { state: "stable", reason: null },
  );
});
test("waits only for an explicitly progressing atomic publication", () => {
  assert.deepEqual(
    classifyZonePublicationConvergence({
      status: "updating",
      serving: true,
      checks: { ...healthyChecks, activeCurrent: false },
    }),
    { state: "updating", reason: "activeCurrent" },
  );
});

test("rejects a stale or non-serving publication", () => {
  assert.deepEqual(
    classifyZonePublicationConvergence({
      status: "stale",
      serving: true,
      checks: healthyChecks,
    }),
    { state: "blocked", reason: "stale" },
  );
  assert.deepEqual(
    classifyZonePublicationConvergence({
      status: "updating",
      serving: false,
      checks: healthyChecks,
    }),
    { state: "blocked", reason: "updating" },
  );
});

test("rejects an updating publication without recent progress", () => {
  assert.deepEqual(
    classifyZonePublicationConvergence({
      status: "updating",
      serving: true,
      checks: { ...healthyChecks, activeCurrent: false, recentProgress: false },
    }),
    { state: "blocked", reason: "activeCurrent" },
  );
});
