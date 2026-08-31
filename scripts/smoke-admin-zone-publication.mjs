import assert from "node:assert/strict";

const zonePublicationCheckKeys = [
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
  "certifiedHistoricRepair",
  "certifiedRun",
  "snapshotsComplete",
  "recentProgress",
];

function collectObjectKeys(value, keys = []) {
  if (!value || typeof value !== "object") {
    return keys;
  }
  for (const [key, child] of Object.entries(value)) {
    keys.push(key);
    collectObjectKeys(child, keys);
  }
  return keys;
}

function previousDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

export function parseExpectedZonePublicationMode(value) {
  const mode = value?.trim() || "healthy";
  assert.ok(
    ["healthy", "legacy"].includes(mode),
    "VIGIEAU_EXPECT_ZONE_PUBLICATION_MODE must be healthy or legacy",
  );
  return mode;
}

export function assertZonePublicationResponse({ body, httpStatus, mode }) {
  assert.ok(
    body && typeof body === "object",
    "Zone publication health is empty",
  );
  assert.match(
    String(body.businessDate || ""),
    /^\d{4}-\d{2}-\d{2}$/,
    "The zone publication business date is invalid",
  );
  assert.equal(
    body.requiredHistoricThrough,
    previousDate(body.businessDate),
    "The zone publication historic deadline is inconsistent",
  );
  assert.ok(
    body.checks && typeof body.checks === "object",
    "The zone publication health checks are unavailable",
  );
  for (const key of zonePublicationCheckKeys) {
    assert.equal(
      typeof body.checks[key],
      "boolean",
      `Zone publication check ${key} is missing`,
    );
  }
  assert.equal(
    collectObjectKeys(body).some((key) =>
      /(^id$|Id$|revision|version|error)/i.test(key),
    ),
    false,
    "The public zone publication health exposes an internal field",
  );

  if (mode === "healthy") {
    assert.equal(
      httpStatus,
      200,
      "The zone publication health did not return 200",
    );
    assert.equal(
      body.status,
      "healthy",
      "The zone publication is not fully synchronized",
    );
    assert.equal(
      body.serving,
      true,
      "The active zone publication is not served by every live public instance",
    );
    for (const key of [
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
      "certifiedRun",
      "snapshotsComplete",
    ]) {
      assert.equal(
        body.checks[key],
        true,
        `Zone publication check ${key} is not healthy`,
      );
    }
    assert.ok(
      ["complete", "certified"].includes(body.historicStatus),
      `Unsupported healthy historic status ${body.historicStatus}`,
    );
    if (body.historicStatus === "complete") {
      for (const key of ["historicClean", "historicCursors", "historicRun"]) {
        assert.equal(
          body.checks[key],
          true,
          `Complete history check ${key} is not healthy`,
        );
      }
    } else {
      assert.equal(
        body.checks.certifiedHistoricRepair,
        true,
        "Certified history has no active range-aware repair",
      );
      assert.equal(
        body.checks.historicClean,
        false,
        "Certified history unexpectedly reports a clean mutable range",
      );
    }
    return;
  }

  assert.equal(
    httpStatus,
    503,
    "Legacy zone publication health must return 503",
  );
  assert.equal(
    body.status,
    "stale",
    "Legacy zone publication health is not explicitly stale",
  );
  assert.equal(
    body.serving,
    false,
    "Legacy mode unexpectedly reports a versioned publication as served",
  );
  for (const key of [
    "enabled",
    "automaticPublishing",
    "activeServing",
    "activeCurrent",
    "legacyPromotion",
  ]) {
    assert.equal(
      body.checks[key],
      false,
      `Legacy zone publication check ${key} is unexpectedly enabled`,
    );
  }
  for (const key of ["clock", "candidateClear", "currentStatistics"]) {
    assert.equal(
      body.checks[key],
      true,
      `Legacy zone publication check ${key} reports an independent failure`,
    );
  }
}
