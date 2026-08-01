import assert from "node:assert/strict";

const apiBase = (
  process.env.VIGIEAU_ADMIN_API_URL || "https://api.admin.vigieau.beta.gouv.fr"
).replace(/\/+$/, "");
const frontBase = (
  process.env.VIGIEAU_ADMIN_FRONT_URL || "https://admin.vigieau.beta.gouv.fr"
).replace(/\/+$/, "");
const timeoutMs = Number(process.env.VIGIEAU_SMOKE_TIMEOUT_MS || 15_000);
const allowUnpublishedExternal =
  process.env.VIGIEAU_ALLOW_UNPUBLISHED_EXTERNAL === "true";
const expectedSandreModes = (process.env.VIGIEAU_EXPECT_SANDRE_MODES || "safe")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const expectedDepartmentCount = Number(
  process.env.VIGIEAU_EXPECT_DEPARTMENT_COUNT || 101,
);
const expectedMapArchiveStatus =
  process.env.VIGIEAU_EXPECT_MAP_ARCHIVES || "disabled";

assert.ok(
  expectedSandreModes.length > 0 &&
    expectedSandreModes.every((mode) => ["audit", "safe"].includes(mode)),
  "VIGIEAU_EXPECT_SANDRE_MODES must contain audit and/or safe",
);
assert.ok(
  Number.isInteger(expectedDepartmentCount) && expectedDepartmentCount > 0,
  "VIGIEAU_EXPECT_DEPARTMENT_COUNT must be a positive integer",
);
assert.ok(
  ["disabled", "configured"].includes(expectedMapArchiveStatus),
  "VIGIEAU_EXPECT_MAP_ARCHIVES must be disabled or configured",
);

async function json(path) {
  return jsonUrl(`${apiBase}/api/${path}`);
}

async function jsonUrl(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  assert.equal(
    response.status,
    200,
    `${url} returned ${response.status}: ${body.slice(0, 500)}`,
  );
  return body ? JSON.parse(body) : null;
}

const frontResponse = await fetch(`${frontBase}/`, {
  headers: { Accept: "text/html", "Cache-Control": "no-cache" },
  signal: AbortSignal.timeout(timeoutMs),
});
assert.equal(frontResponse.status, 200, "The admin front is unavailable");
assert.match(
  frontResponse.headers.get("content-type") || "",
  /text\/html/i,
  "The admin front did not return HTML",
);
await frontResponse.body?.cancel();

const proxiedLive = await jsonUrl(`${frontBase}/api/health/live`);
assert.equal(
  proxiedLive.status,
  "ok",
  "The admin front /api proxy is unavailable",
);

const live = await json("health/live");
assert.equal(live.status, "ok", "The admin API process is not live");

const ready = await json("health/ready");
assert.deepEqual(
  ready,
  { status: "ready", database: "up" },
  "The admin API is not ready",
);

const sandreReferences = await json("health/sandre-references");
assert.equal(
  sandreReferences.status,
  "healthy",
  "Operational orders reference disabled SANDRE zones",
);

const sandreSynchronization = await json("health/sandre-synchronization");
assert.equal(
  sandreSynchronization.status,
  "healthy",
  "The SANDRE synchronization is not healthy",
);
assert.ok(
  expectedSandreModes.includes(sandreSynchronization.mode),
  `Unexpected SANDRE mode ${sandreSynchronization.mode}; expected ${expectedSandreModes.join(", ")}`,
);
const sandreSummaryKeys = [
  "totalDepartments",
  "trackedDepartments",
  "staleDepartments",
  "forcedAuditCompletedDepartments",
  "pendingForcedAuditDepartments",
  "appliedDepartments",
  "staleAppliedDepartments",
  "pendingApplicationDepartments",
  "blockedDepartments",
  "failedBatches",
  "blockedBatches",
];
for (const key of sandreSummaryKeys) {
  assert.equal(
    Object.hasOwn(sandreSynchronization.summary || {}, key),
    true,
    `SANDRE synchronization summary is missing ${key}`,
  );
}
assert.equal(
  Number(sandreSynchronization.summary.totalDepartments),
  expectedDepartmentCount,
  `Unexpected SANDRE department count; expected ${expectedDepartmentCount}`,
);
assert.equal(
  Number(sandreSynchronization.summary.trackedDepartments),
  expectedDepartmentCount,
  "Not every department has a persisted SANDRE observation",
);
for (const key of [
  "staleDepartments",
  "blockedDepartments",
  "failedBatches",
  "blockedBatches",
]) {
  assert.equal(
    Number(sandreSynchronization.summary[key]),
    0,
    `SANDRE synchronization reports ${key}`,
  );
}
if (["audit", "safe"].includes(sandreSynchronization.mode)) {
  assert.ok(
    sandreSynchronization.requiredObservationAfter,
    "The rollout audit cutoff is not configured",
  );
  assert.equal(
    Number(sandreSynchronization.summary.forcedAuditCompletedDepartments),
    expectedDepartmentCount,
    "Not every department completed a fresh rollout audit",
  );
  assert.equal(
    Number(sandreSynchronization.summary.pendingForcedAuditDepartments),
    0,
    "Some departments still require a fresh rollout audit",
  );
}
if (sandreSynchronization.mode === "safe") {
  assert.equal(
    Number(sandreSynchronization.summary.appliedDepartments),
    expectedDepartmentCount,
    "Not every department has a persisted SANDRE application",
  );
  for (const key of [
    "staleAppliedDepartments",
    "pendingApplicationDepartments",
  ]) {
    assert.equal(
      Number(sandreSynchronization.summary[key]),
      0,
      `SANDRE synchronization reports ${key}`,
    );
  }
}

const mapArchives = await json("health/map-archives");
assert.equal(
  mapArchives.status,
  expectedMapArchiveStatus,
  `Unexpected map archive mode ${mapArchives.status}`,
);
assert.equal(
  mapArchives.enabled,
  expectedMapArchiveStatus === "configured",
  "The map archive flag and health status disagree",
);
assert.equal(
  Number(sandreReferences.invalidReferences?.total),
  0,
  "Operational disabled-zone references remain",
);

const clock = await json("health/clock");
assert.equal(
  clock.status,
  "healthy",
  "The admin clock heartbeat is not healthy",
);
assert.ok(clock.lastSeenAt, "The admin clock has no persisted heartbeat");
assert.ok(
  Number(clock.ageSeconds) <= Number(clock.staleAfterSeconds),
  "The admin clock heartbeat is stale",
);

const externalPublications = await json("health/external-publications");
if (allowUnpublishedExternal) {
  assert.ok(
    ["healthy", "never_succeeded"].includes(externalPublications.status),
    "The external publication health is neither healthy nor intentionally unpublished",
  );
} else {
  assert.equal(
    externalPublications.status,
    "healthy",
    "An external publication is failed or stale",
  );
  assert.equal(
    Number(externalPublications.failedResourceCount || 0),
    0,
    "An external resource remains failed",
  );
}
assert.equal(
  Object.hasOwn(externalPublications.lastRun || {}, "error"),
  false,
  "The external publication health endpoint exposes an error",
);

console.log(
  JSON.stringify({
    status: "ok",
    clock: {
      lastSeenAt: clock.lastSeenAt,
      ageSeconds: clock.ageSeconds,
    },
    externalPublications: externalPublications.status,
    sandreReferences: sandreReferences.invalidReferences,
    sandreSynchronization: {
      mode: sandreSynchronization.mode,
      oldestObservationAt: sandreSynchronization.oldestObservationAt,
      summary: sandreSynchronization.summary,
    },
    mapArchives,
    adminFront: frontBase,
  }),
);
