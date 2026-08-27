import assert from "node:assert/strict";

const PARIS_TIME_ZONE = "Europe/Paris";
export const DEFAULT_ZONE_PUBLICATION_DEADLINE = "06:00";

const legacyNotFound = {
  statusCode: 404,
  message: "Aucune publication versionnée n'est disponible.",
};

function parseDeadline(value) {
  assert.match(
    value,
    /^\d{2}:\d{2}$/,
    "VIGIEAU_ZONE_PUBLICATION_DEADLINE must use the HH:mm format",
  );
  const [hours, minutes] = value.split(":").map(Number);
  assert.ok(
    hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59,
    "VIGIEAU_ZONE_PUBLICATION_DEADLINE must be a valid Paris time",
  );
  return hours * 60 + minutes;
}

function parisDateTime(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PARIS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    minutes: Number(value("hour")) * 60 + Number(value("minute")),
  };
}

function previousDate(date) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function timestamp(value, label) {
  const parsed = new Date(value || "");
  assert.ok(!Number.isNaN(parsed.getTime()), `${label} is not a timestamp`);
  return parsed;
}

export function getExpectedZoneBusinessDate({
  deadline = DEFAULT_ZONE_PUBLICATION_DEADLINE,
  now = new Date(),
} = {}) {
  assert.ok(
    !Number.isNaN(now.getTime()),
    "The zone publication clock is invalid",
  );
  const current = parisDateTime(now);
  return current.minutes < parseDeadline(deadline)
    ? previousDate(current.date)
    : current.date;
}

export function parseExpectedPublicZonePublicationMode(value) {
  const mode = value?.trim() || "healthy";
  assert.ok(
    ["healthy", "legacy"].includes(mode),
    "VIGIEAU_EXPECT_ZONE_PUBLICATION_MODE must be healthy or legacy",
  );
  return mode;
}

export function assertPublicZoneCache({
  body,
  deadline = DEFAULT_ZONE_PUBLICATION_DEADLINE,
  expectedMode,
  minimumZoneCount,
  now = new Date(),
}) {
  assert.ok(
    body && typeof body === "object",
    "The public zone cache health is empty",
  );
  assert.equal(body.status, "ready", "The public zone cache is not ready");
  assert.equal(body.usable, true, "The public zone cache is not usable");
  assert.equal(body.fresh, true, "The public zone cache is not fresh");
  assert.equal(
    typeof body.loading,
    "boolean",
    "The public zone cache loading flag is invalid",
  );
  assert.equal(body.lastError, null, "The public zone cache reports an error");

  const loadedVersion = timestamp(
    body.loadedVersion,
    "The loaded zone cache version",
  );
  timestamp(body.availableVersion, "The available zone cache version");
  assert.equal(
    body.loadedVersion,
    body.availableVersion,
    "The loaded zone cache version is obsolete",
  );
  const loadedAt = timestamp(body.loadedAt, "The zone cache load date");
  assert.ok(
    loadedAt.getTime() <= now.getTime() + 60_000,
    "The zone cache load date is implausibly in the future",
  );
  timestamp(body.lastVersionCheckAt, "The zone cache version check date");
  const successfulCheck = timestamp(
    body.lastSuccessfulVersionCheckAt,
    "The successful zone cache version check date",
  );
  assert.ok(
    successfulCheck.getTime() <= now.getTime() + 60_000,
    "The zone cache version check is implausibly in the future",
  );

  const expectedBusinessDate = getExpectedZoneBusinessDate({ deadline, now });
  const loadedBusinessDate = parisDateTime(loadedVersion).date;
  const currentBusinessDate = parisDateTime(now).date;
  assert.ok(
    loadedBusinessDate >= expectedBusinessDate,
    "The zone cache version is older than the expected business date",
  );
  assert.ok(
    loadedBusinessDate <= currentBusinessDate,
    "The zone cache version is later than the current business date",
  );

  assert.ok(
    body.counts && typeof body.counts === "object",
    "The zone cache counts are missing",
  );
  for (const key of [
    "zones",
    "features",
    "communes",
    "communeAssociations",
    "arretesMunicipaux",
  ]) {
    assert.ok(
      Number.isInteger(body.counts[key]) && body.counts[key] >= 0,
      `The zone cache count ${key} is invalid`,
    );
  }
  assert.ok(
    body.counts.zones >= minimumZoneCount,
    `The zone cache contains fewer than ${minimumZoneCount} zones`,
  );
  assert.equal(
    body.counts.features,
    body.counts.zones,
    "The zone and spatial feature counts disagree",
  );

  assert.ok(
    body.publication && typeof body.publication === "object",
    "The zone cache publication status is missing",
  );
  const expectedCacheMode = expectedMode === "legacy" ? "legacy" : "versioned";
  assert.equal(
    body.publication.mode,
    expectedCacheMode,
    `The zone cache publication mode is not ${expectedCacheMode}`,
  );
  assert.ok(
    Number.isInteger(body.publication.cachedPublications) &&
      body.publication.cachedPublications >= 0,
    "The cached publication count is invalid",
  );
  assert.equal(
    typeof body.publication.candidatePreloaded,
    "boolean",
    "The candidate preload flag is invalid",
  );
  assert.ok(
    body.publication.instances &&
      typeof body.publication.instances === "object",
    "The publication instance counts are missing",
  );
  for (const key of ["live", "activeReady", "candidateReady"]) {
    assert.ok(
      Number.isInteger(body.publication.instances[key]) &&
        body.publication.instances[key] >= 0,
      `The publication instance count ${key} is invalid`,
    );
  }

  if (expectedMode === "legacy") {
    assert.equal(
      body.publication.activeId,
      null,
      "Legacy cache has an active publication",
    );
    assert.equal(
      body.publication.activeRevision,
      null,
      "Legacy cache has an active revision",
    );
    assert.equal(
      body.publication.availableActiveId ?? null,
      null,
      "Legacy cache reports an available versioned publication",
    );
  } else {
    assert.match(String(body.publication.activeId || ""), /^[0-9a-f-]{36}$/i);
    assert.ok(
      body.publication.activeRevision,
      "Versioned cache has no active revision",
    );
    assert.equal(
      body.publication.availableActiveId,
      body.publication.activeId,
      "The available and loaded publication identifiers disagree",
    );
  }

  return {
    expectedBusinessDate,
    loadedBusinessDate,
    loadedVersion: body.loadedVersion,
  };
}

export function resolvePublicZonePublication({
  body,
  expectedMode,
  httpStatus,
  cacheStatus,
  legacyGeojsonUrl,
  legacyPmtilesUrl,
  minimumZoneCount,
}) {
  if (expectedMode === "legacy") {
    assert.equal(
      httpStatus,
      404,
      "Legacy zone publication discovery must return 404",
    );
    assert.deepEqual(
      body,
      legacyNotFound,
      "The zone publication 404 is not the expected legacy response",
    );
    assert.ok(legacyGeojsonUrl, "The legacy GeoJSON URL is not configured");
    assert.ok(legacyPmtilesUrl, "The legacy PMTiles URL is not configured");
    return {
      id: null,
      revision: null,
      geojsonUrl: legacyGeojsonUrl,
      pmtilesUrl: legacyPmtilesUrl,
      zoneCount: cacheStatus.counts.zones,
    };
  }

  assert.equal(
    httpStatus,
    200,
    "Healthy zone publication discovery must return 200",
  );
  assert.ok(
    body && typeof body === "object",
    "The active publication is empty",
  );
  assert.match(body.id, /^[0-9a-f-]{36}$/i);
  assert.ok(body.revision, "The active publication has no revision");
  assert.ok(body.geojsonUrl, "The active publication has no GeoJSON URL");
  assert.match(body.geojsonChecksum, /^[0-9a-f]{64}$/i);
  assert.ok(body.pmtilesUrl, "The active publication has no PMTiles URL");
  assert.match(body.pmtilesChecksum, /^[0-9a-f]{64}$/i);
  assert.ok(
    Number.isInteger(body.zoneCount) && body.zoneCount >= minimumZoneCount,
    "The active publication has an invalid zone count",
  );
  assert.equal(
    body.id,
    cacheStatus.publication.activeId,
    "The manifest and cache publication identifiers disagree",
  );
  assert.equal(
    String(body.revision),
    String(cacheStatus.publication.activeRevision),
    "The manifest and cache publication revisions disagree",
  );
  assert.equal(
    body.zoneCount,
    cacheStatus.counts.zones,
    "The manifest and cache zone counts disagree",
  );
  if (cacheStatus.publication.loadedFingerprint) {
    assert.equal(
      body.contentFingerprint,
      cacheStatus.publication.loadedFingerprint,
      "The manifest and cache fingerprints disagree",
    );
  }
  return body;
}

export function assertLegacyArtifactFreshness({
  label,
  lastModified,
  loadedBusinessDate,
  loadedVersion,
  maximumSkewMinutes,
}) {
  assert.ok(
    Number.isInteger(maximumSkewMinutes) && maximumSkewMinutes > 0,
    "VIGIEAU_LEGACY_ARTIFACT_MAX_SKEW_MINUTES must be a positive integer",
  );
  const artifactVersion = timestamp(lastModified, `${label} Last-Modified`);
  const cacheVersion = timestamp(
    loadedVersion,
    "The loaded zone cache version",
  );
  assert.equal(
    parisDateTime(artifactVersion).date,
    loadedBusinessDate,
    `${label} does not cover the loaded cache business date`,
  );
  assert.ok(
    Math.abs(artifactVersion.getTime() - cacheVersion.getTime()) <=
      maximumSkewMinutes * 60_000,
    `${label} is not aligned with the loaded zone cache version`,
  );
}
