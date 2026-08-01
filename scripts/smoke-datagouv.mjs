import assert from "node:assert/strict";
import { inspectZipDates, inspectZipEntries } from "./inspect-zip-dates.mjs";

const datasetUrl =
  process.env.VIGIEAU_DATAGOUV_DATASET_URL ||
  "https://www.data.gouv.fr/api/1/datasets/donnee-secheresse-vigieau/";
const historyResourceId =
  process.env.VIGIEAU_DATAGOUV_HISTORY_RESOURCE_ID ||
  "4322064e-cfb4-4c8a-8200-7620f491ccdb";
const adminApiBase = (
  process.env.VIGIEAU_ADMIN_API_URL || "https://api.admin.vigieau.beta.gouv.fr"
).replace(/\/+$/, "");
const expectedMapArchiveStatus =
  process.env.VIGIEAU_EXPECT_MAP_ARCHIVES || "disabled";
const maxAgeHours = Number(process.env.VIGIEAU_DATAGOUV_MAX_AGE_HOURS || 26);
const timeoutMs = Number(process.env.VIGIEAU_SMOKE_TIMEOUT_MS || 30_000);
const contentTimeoutMs = Number(
  process.env.VIGIEAU_DATAGOUV_CONTENT_TIMEOUT_MS || 180_000,
);
const annualScanBytes = Number(
  process.env.VIGIEAU_DATAGOUV_ANNUAL_SCAN_BYTES || Number.MAX_SAFE_INTEGER,
);
const historyScanBytes = Number(
  process.env.VIGIEAU_DATAGOUV_HISTORY_SCAN_BYTES || 32 * 1024 * 1024,
);

function previousCivilDate(date) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1))
    .toISOString()
    .slice(0, 10);
}

function parisSchedule(now = new Date()) {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    hour: Number(value("hour")),
  };
}

const schedule = parisSchedule();
const scheduledSourceDate =
  schedule.hour < 6 ? previousCivilDate(schedule.date) : schedule.date;
const expectedSourceDate =
  process.env.VIGIEAU_DATAGOUV_EXPECTED_SOURCE_DATE || scheduledSourceDate;
const year =
  process.env.VIGIEAU_DATAGOUV_YEAR || expectedSourceDate.slice(0, 4);

assert.match(
  expectedSourceDate,
  /^\d{4}-\d{2}-\d{2}$/,
  "VIGIEAU_DATAGOUV_EXPECTED_SOURCE_DATE must be YYYY-MM-DD",
);
assert.ok(
  ["disabled", "configured"].includes(expectedMapArchiveStatus),
  "VIGIEAU_EXPECT_MAP_ARCHIVES must be disabled or configured",
);
for (const [name, value] of [
  ["VIGIEAU_DATAGOUV_MAX_AGE_HOURS", maxAgeHours],
  ["VIGIEAU_SMOKE_TIMEOUT_MS", timeoutMs],
  ["VIGIEAU_DATAGOUV_CONTENT_TIMEOUT_MS", contentTimeoutMs],
  ["VIGIEAU_DATAGOUV_ANNUAL_SCAN_BYTES", annualScanBytes],
  ["VIGIEAU_DATAGOUV_HISTORY_SCAN_BYTES", historyScanBytes],
]) {
  assert.ok(Number.isFinite(value) && value > 0, `${name} must be positive`);
}

async function request(url, init = {}) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

const mapArchiveHealthResponse = await request(
  `${adminApiBase}/api/health/map-archives`,
  { headers: { Accept: "application/json", "Cache-Control": "no-cache" } },
);
const mapArchiveHealthBody = await mapArchiveHealthResponse.text();
assert.equal(
  mapArchiveHealthResponse.status,
  200,
  `Map archive health returned ${mapArchiveHealthResponse.status}: ${mapArchiveHealthBody.slice(0, 500)}`,
);
const mapArchiveHealth = JSON.parse(mapArchiveHealthBody);
assert.equal(
  mapArchiveHealth.status,
  expectedMapArchiveStatus,
  `Unexpected map archive mode ${mapArchiveHealth.status}`,
);

const metadataResponse = await request(datasetUrl, {
  headers: { Accept: "application/json", "Cache-Control": "no-cache" },
});
assert.equal(
  metadataResponse.status,
  200,
  "The data.gouv dataset is unavailable",
);
const dataset = await metadataResponse.json();
const resources = Array.isArray(dataset.resources) ? dataset.resources : [];
const communeResource = resources.find(
  (resource) => resource.title?.trim() === `Communes en restrictions - ${year}`,
);
const historyResource = resources.find(
  (resource) => resource.id === historyResourceId,
);
assert.ok(communeResource, `Missing communes resource for ${year}`);
assert.ok(historyResource, "Missing communes history resource");

async function verifyResource(resource, name) {
  assert.equal(
    resource.extras?.["check:available"],
    true,
    `${name} is unavailable`,
  );
  const lastModified = new Date(resource.last_modified);
  assert.ok(
    Number.isFinite(lastModified.getTime()),
    `${name} has no update date`,
  );
  const ageHours = (Date.now() - lastModified.getTime()) / 3_600_000;
  assert.ok(
    ageHours <= maxAgeHours,
    `${name} is ${ageHours.toFixed(1)} hours old`,
  );

  const response = await request(resource.latest || resource.url, {
    headers: { Range: "bytes=0-3", "Cache-Control": "no-cache" },
  });
  assert.ok(
    [200, 206].includes(response.status),
    `${name} returned ${response.status}`,
  );
  const reader = response.body?.getReader();
  assert.ok(reader, `${name} has no response body`);
  const chunk = await reader.read();
  await reader.cancel();
  assert.ok(chunk.value?.length >= 2, `${name} is empty`);
  assert.equal(
    new TextDecoder().decode(chunk.value.slice(0, 2)),
    "PK",
    `${name} is not a ZIP`,
  );

  const advertisedSize = Number(
    resource.filesize || resource.extras?.["check:headers:content-length"] || 0,
  );
  assert.ok(advertisedSize > 22, `${name} has an invalid advertised size`);
  return {
    id: resource.id,
    lastModified: lastModified.toISOString(),
    ageHours: Number(ageHours.toFixed(2)),
    advertisedSize,
  };
}

const [communes, history] = await Promise.all([
  verifyResource(communeResource, `Communes en restrictions - ${year}`),
  verifyResource(historyResource, "Historique Communes"),
]);

communes.content = await inspectZipDates({
  url: communeResource.latest || communeResource.url,
  advertisedSize: communes.advertisedSize,
  expectedDate: expectedSourceDate,
  expectedFileName: `restrictions_communes_${year}.json`,
  scanBytes: annualScanBytes,
  timeoutMs: contentTimeoutMs,
});
assert.equal(
  communes.content.inspection,
  "full",
  "The annual communes resource was not inspected in full",
);

history.content = await inspectZipDates({
  url: historyResource.latest || historyResource.url,
  advertisedSize: history.advertisedSize,
  expectedDate: expectedSourceDate,
  expectedFileName: "historique_communes.json",
  scanBytes: historyScanBytes,
  timeoutMs: contentTimeoutMs,
});

let maps = null;
if (expectedMapArchiveStatus === "configured") {
  const mapSpecifications = [
    {
      kind: "geojson",
      extension: "geojson",
      title:
        "Cartes des zones et arrêtés en vigueur - GEOJSON - Année en cours",
    },
    {
      kind: "pmtiles",
      extension: "pmtiles",
      title:
        "Cartes des zones et arrêtés en vigueur - PMTILES - Année en cours",
    },
  ];
  maps = {};
  for (const specification of mapSpecifications) {
    const resource = resources.find(
      (candidate) => candidate.title?.trim() === specification.title,
    );
    assert.ok(resource, `Missing ${specification.kind} map archive resource`);
    const details = await verifyResource(
      resource,
      `${specification.kind} map archive`,
    );
    const entries = await inspectZipEntries({
      url: resource.latest || resource.url,
      advertisedSize: details.advertisedSize,
      timeoutMs: contentTimeoutMs,
    });
    const actualNames = entries
      .filter(({ name }) => !name.endsWith("/"))
      .map(({ name }) => name)
      .sort();
    const expectedNames = [];
    const expectedEnd = new Date(`${expectedSourceDate}T00:00:00.000Z`);
    for (
      let cursorDate = new Date(`${year}-01-01T00:00:00.000Z`);
      cursorDate <= expectedEnd;
      cursorDate.setUTCDate(cursorDate.getUTCDate() + 1)
    ) {
      const cursor = cursorDate.toISOString().slice(0, 10);
      expectedNames.push(
        `zones_arretes_en_vigueur_${cursor}.${specification.extension}`,
      );
    }
    assert.deepEqual(
      actualNames,
      expectedNames,
      `${specification.kind} map archive is not complete from January 1 through ${expectedSourceDate}`,
    );
    maps[specification.kind] = {
      ...details,
      entryCount: actualNames.length,
      firstEntry: actualNames[0],
      lastEntry: actualNames.at(-1),
    };
  }
}

console.log(
  JSON.stringify({
    status: "ok",
    expectedSourceDate,
    communes,
    history,
    mapArchives: { health: mapArchiveHealth, resources: maps },
  }),
);
