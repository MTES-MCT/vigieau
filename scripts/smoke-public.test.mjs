import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertPublicZoneCache,
  getExpectedZoneBusinessDate,
  parseExpectedPublicZonePublicationMode,
} from "./smoke-public-zone-publication.mjs";

const smokePath = fileURLToPath(new URL("./smoke-public.mjs", import.meta.url));
const activePublicationId = "b1c24878-0000-4000-8000-000000000001";
const activeRevision = "42";
const currentVersion = "2026-08-14T12:00:00.000Z";

function pmtilesHeader(valid = true) {
  const header = Buffer.alloc(127);
  header.write(valid ? "PMTiles" : "Invalid", 0, "ascii");
  header.writeUInt8(3, 7);
  for (const offset of [16, 64, 72, 80, 88]) {
    header.writeBigUInt64LE(1n, offset);
  }
  return header;
}

function healthyPublication(baseUrl, zoneCount = 1) {
  return {
    id: activePublicationId,
    revision: activeRevision,
    geojsonUrl: `${baseUrl}/legacy.geojson`,
    geojsonChecksum: "a".repeat(64),
    pmtilesUrl: `${baseUrl}/legacy.pmtiles`,
    pmtilesChecksum: "b".repeat(64),
    zoneCount,
    contentFingerprint: "c".repeat(64),
  };
}

function zoneCacheStatus({
  availableVersion = currentVersion,
  lastCheckAt = "2026-08-14T12:30:00.000Z",
  loadedAt = "2026-08-14T12:00:05.000Z",
  loadedVersion = currentVersion,
  mode,
  zones,
}) {
  const versioned = mode === "versioned";
  return {
    status: "ready",
    usable: true,
    fresh: true,
    loading: false,
    loadedVersion,
    availableVersion,
    loadedAt,
    lastVersionCheckAt: lastCheckAt,
    lastSuccessfulVersionCheckAt: lastCheckAt,
    lastError: null,
    counts: {
      zones,
      features: zones,
      communes: zones > 0 ? 1 : 0,
      communeAssociations: zones > 0 ? 1 : 0,
      arretesMunicipaux: 0,
    },
    publication: {
      mode,
      activeId: versioned ? activePublicationId : null,
      activeRevision: versioned ? activeRevision : null,
      availableActiveId: versioned ? activePublicationId : null,
      candidateId: null,
      loadedFingerprint: versioned ? "c".repeat(64) : null,
      candidatePreloaded: false,
      cachedPublications: versioned ? 1 : 0,
      instances: {
        live: 2,
        activeReady: versioned ? 2 : 0,
        candidateReady: 0,
      },
    },
  };
}

const legacyNotFound = {
  statusCode: 404,
  message: "Aucune publication versionnée n'est disponible.",
};

async function runSmoke({
  expectedMode,
  artifactLastModified = currentVersion,
  availableVersion = currentVersion,
  cacheMode = expectedMode === "legacy" ? "legacy" : "versioned",
  cacheZones = 1,
  lastCheckAt = "2026-08-14T12:30:00.000Z",
  loadedAt = "2026-08-14T12:00:05.000Z",
  loadedVersion = currentVersion,
  publicationStatus,
  publicationBody,
  validPmtiles = true,
  zoneNow = "2026-08-14T12:30:30.000Z",
  zonesStatus = 200,
}) {
  const requests = [];
  let baseUrl;
  const cacheStatus = zoneCacheStatus({
    availableVersion,
    lastCheckAt,
    loadedAt,
    loadedVersion,
    mode: cacheMode,
    zones: cacheZones,
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url, baseUrl || "http://localhost");
    requests.push(url.href);
    const sendJson = (body, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/health/live") {
      sendJson({ status: "ok" });
      return;
    }
    if (["/api/health/ready", "/api/health/cache"].includes(url.pathname)) {
      sendJson(cacheStatus);
      return;
    }
    if (url.pathname === "/api/zones/publication") {
      sendJson(
        typeof publicationBody === "function"
          ? publicationBody(baseUrl, cacheZones)
          : publicationBody,
        publicationStatus,
      );
      return;
    }
    if (url.pathname === "/legacy.geojson") {
      response.writeHead(206, {
        "content-disposition":
          'attachment; filename="zones_arretes_en_vigueur.geojson"',
        "content-type": "application/geo+json",
        "last-modified": new Date(artifactLastModified).toUTCString(),
      });
      response.end('{"type":"FeatureCollection","features":[]}');
      return;
    }
    if (url.pathname === "/legacy.pmtiles") {
      response.writeHead(206, {
        "content-type": "application/vnd.pmtiles",
        "last-modified": new Date(artifactLastModified).toUTCString(),
      });
      response.end(pmtilesHeader(validPmtiles));
      return;
    }
    if (url.pathname === "/carte/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Carte</title>");
      return;
    }
    if (url.pathname === "/api/zones") {
      sendJson(
        zonesStatus === 200 ? [] : { statusCode: zonesStatus },
        zonesStatus,
      );
      return;
    }
    if (url.pathname === "/search/") {
      sendJson({
        features: [{ geometry: { coordinates: [0.1, 0.2] } }],
      });
      return;
    }
    sendJson({ statusCode: 404 }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [smokePath], {
    env: {
      ...process.env,
      VIGIEAU_API_URL: baseUrl,
      VIGIEAU_FRONT_URL: baseUrl,
      VIGIEAU_ADDRESS_API_URL: baseUrl,
      VIGIEAU_EXPECT_ZONE_PUBLICATION_MODE: expectedMode,
      VIGIEAU_LEGACY_GEOJSON_URL: `${baseUrl}/legacy.geojson`,
      VIGIEAU_LEGACY_PMTILES_URL: `${baseUrl}/legacy.pmtiles`,
      VIGIEAU_EXPECT_TARBES_RESTRICTIONS: "false",
      VIGIEAU_ZONE_PUBLICATION_DEADLINE: "06:00",
      VIGIEAU_ZONE_PUBLICATION_NOW: zoneNow,
      VIGIEAU_SMOKE_TIMEOUT_MS: "2000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return { exitCode, stdout, stderr, requests };
}

test("public zone publication mode defaults to healthy and rejects typos", () => {
  assert.equal(parseExpectedPublicZonePublicationMode(undefined), "healthy");
  assert.equal(parseExpectedPublicZonePublicationMode(" legacy "), "legacy");
  assert.throws(
    () => parseExpectedPublicZonePublicationMode("disabled"),
    /must be healthy or legacy/,
  );
});

test("zone business date follows the explicit Paris deadline across DST", () => {
  assert.equal(
    getExpectedZoneBusinessDate({
      deadline: "06:00",
      now: new Date("2026-03-29T03:59:00.000Z"),
    }),
    "2026-03-28",
  );
  assert.equal(
    getExpectedZoneBusinessDate({
      deadline: "06:00",
      now: new Date("2026-03-29T04:00:00.000Z"),
    }),
    "2026-03-29",
  );
  assert.equal(
    getExpectedZoneBusinessDate({
      deadline: "06:00",
      now: new Date("2026-10-25T04:59:00.000Z"),
    }),
    "2026-10-24",
  );
  assert.equal(
    getExpectedZoneBusinessDate({
      deadline: "06:00",
      now: new Date("2026-10-25T05:00:00.000Z"),
    }),
    "2026-10-25",
  );
});

test("legacy mode accepts today's cache and artifacts before the deadline", async () => {
  const earlyVersion = "2026-08-14T03:30:00.000Z";
  const result = await runSmoke({
    expectedMode: "legacy",
    artifactLastModified: earlyVersion,
    availableVersion: earlyVersion,
    lastCheckAt: "2026-08-14T03:58:00.000Z",
    loadedAt: "2026-08-14T03:31:00.000Z",
    loadedVersion: earlyVersion,
    publicationStatus: 404,
    publicationBody: legacyNotFound,
    zoneNow: "2026-08-14T03:59:00.000Z",
  });

  assert.equal(result.exitCode, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.minimumZoneBusinessDate, "2026-08-13");
  assert.equal(output.zoneBusinessDate, "2026-08-14");
});

test("zone cache policy rejects unusable and stale payloads", () => {
  const body = zoneCacheStatus({ mode: "legacy", zones: 1 });
  const policy = {
    body,
    deadline: "06:00",
    expectedMode: "legacy",
    minimumZoneCount: 1,
    now: new Date("2026-08-14T12:30:30.000Z"),
  };
  assert.throws(
    () =>
      assertPublicZoneCache({ ...policy, body: { ...body, usable: false } }),
    /cache is not usable/,
  );
  assert.throws(
    () => assertPublicZoneCache({ ...policy, body: { ...body, fresh: false } }),
    /cache is not fresh/,
  );
});

test("public smoke keeps the healthy versioned publication contract", async () => {
  const result = await runSmoke({
    expectedMode: "healthy",
    publicationStatus: 200,
    publicationBody: healthyPublication,
  });

  assert.equal(result.exitCode, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.zonePublicationMode, "healthy");
  assert.equal(output.publicationId, activePublicationId);
});

test("healthy mode rejects a manifest count inconsistent with the cache", async () => {
  const result = await runSmoke({
    expectedMode: "healthy",
    publicationStatus: 200,
    publicationBody: (baseUrl) => healthyPublication(baseUrl, 2),
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /manifest and cache zone counts disagree/);
});

test("public smoke accepts the exact legacy 404 and keeps testing stable artifacts", async () => {
  const result = await runSmoke({
    expectedMode: "legacy",
    publicationStatus: 404,
    publicationBody: legacyNotFound,
  });

  assert.equal(result.exitCode, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.zonePublicationMode, "legacy");
  assert.equal(output.publicationId, null);
  assert.ok(result.requests.some((url) => url.endsWith("/legacy.geojson")));
  assert.ok(result.requests.some((url) => url.endsWith("/legacy.pmtiles")));
  assert.ok(
    result.requests.some(
      (url) =>
        new URL(url).pathname === "/api/zones" &&
        !new URL(url).searchParams.has("publicationId"),
    ),
  );
});

test("legacy mode rejects a generic 404", async () => {
  const result = await runSmoke({
    expectedMode: "legacy",
    publicationStatus: 404,
    publicationBody: { statusCode: 404, message: "Not Found" },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /not the expected legacy response/);
});

test("legacy mode rejects publication discovery errors other than 404", async () => {
  const result = await runSmoke({
    expectedMode: "legacy",
    publicationStatus: 503,
    publicationBody: { statusCode: 503, message: "Unavailable" },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /returned 503/);
});

test("healthy mode rejects the legacy 404", async () => {
  const result = await runSmoke({
    expectedMode: "healthy",
    publicationStatus: 404,
    publicationBody: legacyNotFound,
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /must return 200/);
});

test("legacy mode keeps the stable PMTiles artifact strict", async () => {
  const result = await runSmoke({
    expectedMode: "legacy",
    publicationStatus: 404,
    publicationBody: legacyNotFound,
    validPmtiles: false,
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /PMTiles header is invalid/);
});

test("legacy mode keeps public zone lookups strict", async () => {
  const result = await runSmoke({
    expectedMode: "legacy",
    publicationStatus: 404,
    publicationBody: legacyNotFound,
    zonesStatus: 500,
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Tarbes commune lookup returned 500/);
});

test("legacy mode rejects an empty zone cache", async () => {
  const result = await runSmoke({
    expectedMode: "legacy",
    cacheZones: 0,
    publicationStatus: 404,
    publicationBody: legacyNotFound,
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /fewer than 1 zones/);
});

test("legacy mode rejects a versioned cache", async () => {
  const result = await runSmoke({
    expectedMode: "legacy",
    cacheMode: "versioned",
    publicationStatus: 404,
    publicationBody: legacyNotFound,
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /publication mode is not legacy/);
});

test("legacy mode rejects an obsolete loaded version", async () => {
  const result = await runSmoke({
    expectedMode: "legacy",
    loadedVersion: "2026-08-13T12:00:00.000Z",
    availableVersion: currentVersion,
    publicationStatus: 404,
    publicationBody: legacyNotFound,
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /loaded zone cache version is obsolete/);
});

test("legacy mode rejects an equally old loaded and available version", async () => {
  const obsoleteVersion = "2026-08-13T12:00:00.000Z";
  const result = await runSmoke({
    expectedMode: "legacy",
    loadedVersion: obsoleteVersion,
    availableVersion: obsoleteVersion,
    artifactLastModified: obsoleteVersion,
    publicationStatus: 404,
    publicationBody: legacyNotFound,
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /older than the expected business date/);
});

test("legacy mode rejects an artifact older than the loaded cache", async () => {
  const result = await runSmoke({
    expectedMode: "legacy",
    artifactLastModified: "2026-08-13T12:00:00.000Z",
    publicationStatus: 404,
    publicationBody: legacyNotFound,
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /does not cover the loaded cache business date/);
});
