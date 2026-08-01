import assert from "node:assert/strict";

const apiBase = (
  process.env.VIGIEAU_API_URL || "https://api.vigieau.beta.gouv.fr"
).replace(/\/+$/, "");
const frontBase = (
  process.env.VIGIEAU_FRONT_URL || "https://vigieau.gouv.fr"
).replace(/\/+$/, "");
const addressApi = (
  process.env.VIGIEAU_ADDRESS_API_URL || "https://api-adresse.data.gouv.fr"
).replace(/\/+$/, "");
const timeoutMs = Number(process.env.VIGIEAU_SMOKE_TIMEOUT_MS || 15_000);
const minimumZoneCount = Number(process.env.VIGIEAU_MIN_ZONE_COUNT || 1);

assert.ok(
  Number.isInteger(minimumZoneCount) && minimumZoneCount >= 0,
  "VIGIEAU_MIN_ZONE_COUNT must be a non-negative integer",
);

async function request(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return response;
}

async function json(url, expectedStatus = 200) {
  const response = await request(url, {
    headers: { Accept: "application/json" },
  });
  const body = await response.text();
  assert.equal(
    response.status,
    expectedStatus,
    `${url} returned ${response.status}: ${body.slice(0, 500)}`,
  );
  return body ? JSON.parse(body) : null;
}

for (const healthPath of ["live", "ready", "cache"]) {
  await json(`${apiBase}/api/health/${healthPath}`);
}

const publication = await json(`${apiBase}/api/zones/publication`);
assert.match(publication.id, /^[0-9a-f-]{36}$/i);
assert.ok(publication.revision, "The active publication has no revision");
assert.ok(publication.geojsonUrl, "The active publication has no GeoJSON URL");
assert.match(publication.geojsonChecksum, /^[0-9a-f]{64}$/i);
assert.ok(publication.pmtilesUrl, "The active publication has no PMTiles URL");
assert.match(publication.pmtilesChecksum, /^[0-9a-f]{64}$/i);
assert.ok(
  Number.isInteger(publication.zoneCount) &&
    publication.zoneCount >= minimumZoneCount,
  "The active publication has an invalid zone count",
);

const geojsonResponse = await request(publication.geojsonUrl, {
  headers: { Range: "bytes=0-63", "Cache-Control": "no-cache" },
});
assert.ok(
  [200, 206].includes(geojsonResponse.status),
  `GeoJSON Range returned ${geojsonResponse.status}`,
);
const geojsonReader = geojsonResponse.body?.getReader();
assert.ok(geojsonReader, "The GeoJSON response has no body");
const geojsonChunk = await geojsonReader.read();
await geojsonReader.cancel();
assert.equal(
  new TextDecoder().decode(geojsonChunk.value).trimStart().slice(0, 1),
  "{",
  "The GeoJSON artifact is invalid",
);

const pmtilesResponse = await request(publication.pmtilesUrl, {
  headers: { Range: "bytes=0-126" },
});
assert.equal(
  pmtilesResponse.status,
  206,
  `PMTiles Range returned ${pmtilesResponse.status}`,
);
const pmtilesHeader = new Uint8Array(await pmtilesResponse.arrayBuffer());
assert.ok(pmtilesHeader.length >= 127, "The PMTiles header is truncated");
assert.equal(
  new TextDecoder().decode(pmtilesHeader.slice(0, 7)),
  "PMTiles",
  "The PMTiles header is invalid",
);
const header = new DataView(pmtilesHeader.buffer);
assert.equal(header.getUint8(7), 3, "The PMTiles version is unsupported");
const uint64 = (offset) => Number(header.getBigUint64(offset, true));
const pmtilesCounts = {
  rootDirectoryLength: uint64(16),
  tileDataLength: uint64(64),
  addressedTiles: uint64(72),
  tileEntries: uint64(80),
  tileContents: uint64(88),
};
if (publication.zoneCount === 0) {
  for (const name of [
    "tileDataLength",
    "addressedTiles",
    "tileEntries",
    "tileContents",
  ]) {
    assert.equal(
      pmtilesCounts[name],
      0,
      `The empty PMTiles ${name} is nonzero`,
    );
  }
} else {
  for (const [name, count] of Object.entries(pmtilesCounts)) {
    assert.ok(count > 0, `The PMTiles ${name} is empty`);
  }
}

const mapResponse = await request(`${frontBase}/carte/`, {
  headers: { Accept: "text/html" },
});
assert.equal(mapResponse.status, 200, "The public map page is unavailable");
assert.match(
  mapResponse.headers.get("content-type") || "",
  /text\/html/i,
  "The public map did not return HTML",
);
await mapResponse.body?.cancel();

const publicationQuery = `publicationId=${encodeURIComponent(publication.id)}`;
const communeResponse = await request(
  `${apiBase}/api/zones?commune=65440&${publicationQuery}`,
  { headers: { Accept: "application/json", "Cache-Control": "no-cache" } },
);
const communeBody = await communeResponse.text();
assert.ok(
  [200, 409].includes(communeResponse.status),
  `Tarbes commune lookup returned ${communeResponse.status}: ${communeBody.slice(0, 500)}`,
);
let communeZones = null;
let communeConflict = null;
if (communeResponse.status === 200) {
  communeZones = JSON.parse(communeBody);
  assert.ok(
    Array.isArray(communeZones),
    "The Tarbes commune response is not a list",
  );
} else {
  communeConflict = JSON.parse(communeBody);
  assert.equal(
    communeConflict?.statusCode,
    409,
    "The Tarbes ambiguity response is not a structured conflict",
  );
  assert.match(
    String(communeConflict?.message || ""),
    /plusieurs zones d.alerte/i,
    "The Tarbes conflict does not explain the zone ambiguity",
  );
}

const addressResult = await json(
  `${addressApi}/search/?q=${encodeURIComponent("10 rue Brauhauban 65000 Tarbes")}&limit=1&type=housenumber`,
);
const coordinates = addressResult?.features?.[0]?.geometry?.coordinates;
assert.equal(coordinates?.length, 2, "No precise Tarbes address was resolved");
const preciseZones = await json(
  `${apiBase}/api/zones?lon=${encodeURIComponent(coordinates[0])}&lat=${encodeURIComponent(coordinates[1])}&commune=65440&${publicationQuery}`,
);
assert.ok(
  Array.isArray(preciseZones),
  "The precise Tarbes response is not a list",
);
if (process.env.VIGIEAU_EXPECT_TARBES_RESTRICTIONS === "true") {
  assert.ok(
    preciseZones.length > 0,
    "No zone is returned for a precise Tarbes address",
  );
}
if (communeResponse.status === 409) {
  assert.ok(
    preciseZones.length > 0,
    "Tarbes asks for a precise address but that address returns no restriction",
  );
} else if (preciseZones.length > 0) {
  assert.ok(
    communeZones.length > 0,
    "Tarbes has restrictions at a precise address but the commune lookup is empty",
  );
}
assert.ok(
  preciseZones.every((zone) => typeof zone.type === "string"),
  "A Tarbes zone has no water type",
);

console.log(
  JSON.stringify({
    status: "ok",
    publicationId: publication.id,
    revision: publication.revision,
    zoneCount: publication.zoneCount,
    minimumZoneCount,
    pmtilesCounts,
    tarbesCommuneStatus: communeResponse.status,
    tarbesCommuneZoneCount: communeZones?.length ?? null,
    tarbesConflict: communeConflict?.message ?? null,
    tarbesZoneTypes: [...new Set(preciseZones.map((zone) => zone.type))].sort(),
  }),
);
