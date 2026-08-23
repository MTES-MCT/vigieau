import assert from "node:assert/strict";

const tarbesCheckModes = ["adaptive", "strict", "skip"];
const tarbesWaterTypes = ["AEP", "SUP", "SOU"];
const tarbesSeverityRanks = new Map([
  [null, 0],
  [undefined, 0],
  ["vigilance", 1],
  ["alerte", 2],
  ["alerte_renforcee", 3],
  ["crise", 4],
]);

export function parseTarbesCheckMode(value) {
  const mode = value?.trim() || "adaptive";
  assert.ok(
    tarbesCheckModes.includes(mode),
    "VIGIEAU_BROWSER_TARBES_MODE must be adaptive, strict, or skip",
  );
  return mode;
}

export function resolveTarbesLookupOutcome(mode, status) {
  assert.notEqual(mode, "skip", "Tarbes lookup cannot run in skip mode");
  if (mode === "strict") {
    assert.equal(status, 409, `Tarbes municipality lookup returned ${status}`);
    return "precision";
  }

  assert.equal(mode, "adaptive", `Unsupported Tarbes check mode: ${mode}`);
  assert.ok(
    [200, 409].includes(status),
    `Tarbes municipality lookup returned ${status}`,
  );
  return status === 409 ? "precision" : "situation";
}

export function isTarbesZoneLookupUrl(value) {
  const url = new URL(value);
  return (
    /^\/(?:api\/)?zones(?:\/v2)?\/?$/.test(url.pathname) &&
    url.searchParams.get("commune") === "65440"
  );
}

export function buildTarbesSituationExpectations(payload) {
  assert.ok(
    Array.isArray(payload),
    "The Tarbes commune response is not a list",
  );

  const zones = payload.map((zone) => {
    assert.ok(
      zone && typeof zone === "object",
      "Tarbes returned an invalid zone",
    );
    assert.ok(
      tarbesWaterTypes.includes(zone.type),
      `Tarbes returned an unsupported water type: ${zone.type}`,
    );
    assert.ok(
      typeof zone.id === "string" || Number.isInteger(zone.id),
      "Tarbes returned a zone without an identifier",
    );
    assert.ok(
      tarbesSeverityRanks.has(zone.niveauGravite),
      `Tarbes returned an unsupported severity: ${zone.niveauGravite}`,
    );
    return {
      id: String(zone.id),
      name:
        typeof zone.nom === "string"
          ? zone.nom.replace(/\s+/g, " ").trim()
          : "",
      type: zone.type,
      severityRank: tarbesSeverityRanks.get(zone.niveauGravite),
    };
  });

  return tarbesWaterTypes.map((type) => ({
    type,
    zones: zones
      .filter((zone) => zone.type === type)
      .sort((left, right) => right.severityRank - left.severityRank),
  }));
}
