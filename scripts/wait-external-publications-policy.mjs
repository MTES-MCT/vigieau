import assert from "node:assert/strict";

const transientHistoricBlockers = new Set([
  "zone_publication_not_ready",
  "zone_publication_promotion_retry",
  "current_daily_not_ready",
  "statistic_cache_not_ready",
  "statistic_cache_outdated",
  "statistic_cache_quorum_incomplete",
]);

export function classifyExternalPublicationConvergence(
  body,
  { maximumBlockingAgeSeconds = 60 * 60 } = {},
) {
  assert.ok(body && typeof body === "object", "External publication health is empty");
  assert.ok(
    Number.isInteger(maximumBlockingAgeSeconds) && maximumBlockingAgeSeconds > 0,
    "External publication maximum blocking age must be positive",
  );
  const historicExport = body.historicExport;
  assert.ok(
    historicExport && typeof historicExport === "object",
    "Historic export readiness is unavailable",
  );

  if (
    body.status === "healthy" &&
    Number(body.failedResourceCount || 0) === 0 &&
    body.networkRetry === null &&
    historicExport.status === "ready" &&
    body.lastRun?.scheduledFor === historicExport.scheduledFor &&
    body.lastRun.status === "succeeded"
  ) {
    return { state: "stable", reason: null };
  }

  if (historicExport.status === "blocked") {
    if (
      transientHistoricBlockers.has(historicExport.blocker) &&
      Number.isFinite(Number(historicExport.blockingAgeSeconds)) &&
      Number(historicExport.blockingAgeSeconds) <= maximumBlockingAgeSeconds
    ) {
      return { state: "updating", reason: historicExport.blocker };
    }
    return {
      state: "blocked",
      reason: historicExport.blocker || "historic_export_blocked",
    };
  }

  if (body.networkRetry?.status === "network_retry") {
    return { state: "updating", reason: "network_retry" };
  }

  const scheduledFor = historicExport.scheduledFor;
  const lastRun = body.lastRun;
  if (
    historicExport.status === "ready" &&
    (!lastRun ||
      lastRun.scheduledFor !== scheduledFor ||
      lastRun.status === "running")
  ) {
    return { state: "updating", reason: "daily_publication_pending" };
  }

  return {
    state: "blocked",
    reason:
      lastRun?.status === "failed"
        ? "daily_publication_failed"
        : String(body.status || "external_publication_inconsistent"),
  };
}
