import assert from "node:assert/strict";

const stableCheckKeys = [
  "enabled",
  "automaticPublishing",
  "clock",
  "activeServing",
  "activeCurrent",
  "candidateClear",
  "legacyPromotion",
  "currentStatistics",
  "currentSnapshot",
  "certifiedRun",
];

const updatingCheckKeys = [
  "enabled",
  "automaticPublishing",
  "clock",
  "activeServing",
  "recentProgress",
];

export function classifyZonePublicationConvergence(body) {
  assert.ok(body && typeof body === "object", "Zone publication health is empty");
  assert.ok(
    body.checks && typeof body.checks === "object",
    "Zone publication health checks are unavailable",
  );

  if (
    body.status === "healthy" &&
    body.serving === true &&
    stableCheckKeys.every((key) => body.checks[key] === true)
  ) {
    return { state: "stable", reason: null };
  }

  if (
    body.status === "updating" &&
    body.serving === true &&
    updatingCheckKeys.every((key) => body.checks[key] === true)
  ) {
    return {
      state: "updating",
      reason: stableCheckKeys.find((key) => body.checks[key] !== true) || null,
    };
  }

  return {
    state: "blocked",
    reason:
      body.status === "stale" || body.status === "unavailable"
        ? body.status
        : stableCheckKeys.find((key) => body.checks[key] !== true) ||
          String(body.status || "unknown"),
  };
}
