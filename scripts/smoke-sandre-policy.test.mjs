import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSandreHealth,
  parseExpectedSandreModes,
} from "./smoke-sandre-policy.mjs";

const healthySynchronization = {
  status: "healthy",
  mode: "safe",
  requiredObservationAfter: "2026-08-23T13:45:25.000Z",
  oldestObservationAt: "2026-08-31T00:00:00.000Z",
  summary: {
    totalDepartments: 101,
    trackedDepartments: 101,
    staleDepartments: 0,
    forcedAuditCompletedDepartments: 101,
    pendingForcedAuditDepartments: 0,
    appliedDepartments: 101,
    staleAppliedDepartments: 0,
    pendingApplicationDepartments: 0,
    recomputePendingDepartments: 0,
    blockedDepartments: 0,
    failedBatches: 0,
    blockedBatches: 0,
  },
};

test("accepts a fully healthy safe SANDRE state", () => {
  const result = assertSandreHealth({
    references: { status: "healthy", invalidReferences: { total: 0 } },
    synchronization: healthySynchronization,
    expectedModes: parseExpectedSandreModes("safe"),
    expectedDepartmentCount: 101,
  });
  assert.equal(result.mode, "safe");
});
test("rejects blocked departments even when references are valid", () => {
  assert.throws(
    () =>
      assertSandreHealth({
        references: { status: "healthy", invalidReferences: { total: 0 } },
        synchronization: {
          ...healthySynchronization,
          status: "blocked",
          summary: {
            ...healthySynchronization.summary,
            blockedDepartments: 2,
            blockedBatches: 2,
          },
        },
        expectedModes: ["safe"],
        expectedDepartmentCount: 101,
      }),
    /not healthy/,
  );
});

test("rejects invalid operational references", () => {
  assert.throws(
    () =>
      assertSandreHealth({
        references: { status: "healthy", invalidReferences: { total: 1 } },
        synchronization: healthySynchronization,
        expectedModes: ["safe"],
        expectedDepartmentCount: 101,
      }),
    /disabled-zone references remain/,
  );
});
