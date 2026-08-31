import assert from "node:assert/strict";

export function parseExpectedSandreModes(value) {
  const modes = (value || "safe")
    .split(",")
    .map((mode) => mode.trim())
    .filter(Boolean);
  assert.ok(
    modes.length > 0 && modes.every((mode) => ["audit", "safe"].includes(mode)),
    "VIGIEAU_EXPECT_SANDRE_MODES must contain audit and/or safe",
  );
  return modes;
}
export function assertSandreHealth({
  references,
  synchronization,
  expectedModes,
  expectedDepartmentCount,
}) {
  assert.ok(
    Number.isInteger(expectedDepartmentCount) && expectedDepartmentCount > 0,
    "VIGIEAU_EXPECT_DEPARTMENT_COUNT must be a positive integer",
  );
  assert.equal(
    references.status,
    "healthy",
    "Operational orders reference disabled SANDRE zones",
  );
  assert.equal(
    Number(references.invalidReferences?.total),
    0,
    "Operational disabled-zone references remain",
  );
  assert.equal(
    synchronization.status,
    "healthy",
    "The SANDRE synchronization is not healthy",
  );
  assert.ok(
    expectedModes.includes(synchronization.mode),
    `Unexpected SANDRE mode ${synchronization.mode}; expected ${expectedModes.join(", ")}`,
  );

  const summaryKeys = [
    "totalDepartments",
    "trackedDepartments",
    "staleDepartments",
    "forcedAuditCompletedDepartments",
    "pendingForcedAuditDepartments",
    "appliedDepartments",
    "staleAppliedDepartments",
    "pendingApplicationDepartments",
    "recomputePendingDepartments",
    "blockedDepartments",
    "failedBatches",
    "blockedBatches",
  ];
  for (const key of summaryKeys) {
    assert.equal(
      Object.hasOwn(synchronization.summary || {}, key),
      true,
      `SANDRE synchronization summary is missing ${key}`,
    );
  }
  assert.equal(
    Number(synchronization.summary.totalDepartments),
    expectedDepartmentCount,
    `Unexpected SANDRE department count; expected ${expectedDepartmentCount}`,
  );
  assert.equal(
    Number(synchronization.summary.trackedDepartments),
    expectedDepartmentCount,
    "Not every department has a persisted SANDRE observation",
  );
  for (const key of [
    "staleDepartments",
    "recomputePendingDepartments",
    "blockedDepartments",
    "failedBatches",
    "blockedBatches",
  ]) {
    assert.equal(
      Number(synchronization.summary[key]),
      0,
      `SANDRE synchronization reports ${key}`,
    );
  }
  if (["audit", "safe"].includes(synchronization.mode)) {
    assert.ok(
      synchronization.requiredObservationAfter,
      "The rollout audit cutoff is not configured",
    );
    assert.equal(
      Number(synchronization.summary.forcedAuditCompletedDepartments),
      expectedDepartmentCount,
      "Not every department completed a fresh rollout audit",
    );
    assert.equal(
      Number(synchronization.summary.pendingForcedAuditDepartments),
      0,
      "Some departments still require a fresh rollout audit",
    );
  }
  if (synchronization.mode === "safe") {
    assert.equal(
      Number(synchronization.summary.appliedDepartments),
      expectedDepartmentCount,
      "Not every department has a persisted SANDRE application",
    );
    for (const key of [
      "staleAppliedDepartments",
      "pendingApplicationDepartments",
    ]) {
      assert.equal(
        Number(synchronization.summary[key]),
        0,
        `SANDRE synchronization reports ${key}`,
      );
    }
  }

  return {
    mode: synchronization.mode,
    oldestObservationAt: synchronization.oldestObservationAt,
    summary: synchronization.summary,
    invalidReferences: references.invalidReferences,
  };
}
