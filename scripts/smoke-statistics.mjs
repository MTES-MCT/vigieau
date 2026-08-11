import assert from "node:assert/strict";
import {
  DEFAULT_STATISTICS_DEADLINE,
  getStatisticFreshnessPolicy,
} from "./smoke-statistics-policy.mjs";

const apiBase = (
  process.env.VIGIEAU_API_URL || "https://api.vigieau.beta.gouv.fr"
).replace(/\/+$/, "");
const timeoutMs = Number(process.env.VIGIEAU_SMOKE_TIMEOUT_MS || 15_000);
const lookbackDays = Number(process.env.VIGIEAU_STATISTICS_LOOKBACK_DAYS || 7);
const configuredMaximumLagDays =
  process.env.VIGIEAU_STATISTICS_MAXIMUM_LAG_DAYS?.trim() === "" ||
  process.env.VIGIEAU_STATISTICS_MAXIMUM_LAG_DAYS === undefined
    ? undefined
    : Number(process.env.VIGIEAU_STATISTICS_MAXIMUM_LAG_DAYS);
const statisticsDeadline =
  process.env.VIGIEAU_STATISTICS_DEADLINE || DEFAULT_STATISTICS_DEADLINE;
const statisticNow = process.env.VIGIEAU_STATISTICS_NOW
  ? new Date(process.env.VIGIEAU_STATISTICS_NOW)
  : new Date();
const freshnessPolicy = getStatisticFreshnessPolicy({
  now: statisticNow,
  deadline: statisticsDeadline,
  maximumLagDays: configuredMaximumLagDays,
});
const { maximumLagDays } = freshnessPolicy;
const sampleCount = Number(process.env.VIGIEAU_STATISTICS_SAMPLE_COUNT || 4);
const expectedDepartmentCount = Number(
  process.env.VIGIEAU_EXPECTED_DEPARTMENT_COUNT || 101,
);
const expectedCommuneCount = Number(
  process.env.VIGIEAU_EXPECTED_COMMUNE_COUNT || 34_943,
);
const communeCode = process.env.VIGIEAU_STATISTICS_COMMUNE_CODE || "65440";
const allowMissingHealth =
  process.env.VIGIEAU_ALLOW_MISSING_STATISTICS_HEALTH === "true";

function assertInteger(value, minimum, name) {
  assert.ok(
    Number.isInteger(value) && value >= minimum,
    `${name} must be an integer greater than or equal to ${minimum}`,
  );
}

assertInteger(timeoutMs, 1, "VIGIEAU_SMOKE_TIMEOUT_MS");
assertInteger(lookbackDays, 1, "VIGIEAU_STATISTICS_LOOKBACK_DAYS");
assertInteger(maximumLagDays, 0, "VIGIEAU_STATISTICS_MAXIMUM_LAG_DAYS");
assertInteger(sampleCount, 2, "VIGIEAU_STATISTICS_SAMPLE_COUNT");
assertInteger(expectedDepartmentCount, 1, "VIGIEAU_EXPECTED_DEPARTMENT_COUNT");
assertInteger(expectedCommuneCount, 1, "VIGIEAU_EXPECTED_COMMUNE_COUNT");
assert.match(
  communeCode,
  /^[0-9AB]{5}$/,
  "VIGIEAU_STATISTICS_COMMUNE_CODE must be an INSEE commune code",
);

function shiftDate(date, days) {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function dateDifferenceInDays(from, to) {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}

function extractDates(rows, label) {
  assert.ok(Array.isArray(rows), `${label} statistics are not a list`);
  assert.ok(rows.length > 0, `${label} statistics are empty`);
  const dates = rows.map(({ date }) => date);
  assert.ok(
    dates.every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)),
    `${label} statistics contain an invalid date`,
  );
  assert.deepEqual(
    dates,
    [...dates].sort(),
    `${label} statistics are not chronologically sorted`,
  );
  assert.equal(
    new Set(dates).size,
    dates.length,
    `${label} statistics contain duplicate dates`,
  );
  for (let index = 1; index < dates.length; index += 1) {
    assert.equal(
      dateDifferenceInDays(dates[index - 1], dates[index]),
      1,
      `${label} statistics contain a gap after ${dates[index - 1]}`,
    );
  }
  return dates;
}

async function requestJson(url, expectedStatuses = [200]) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
      Connection: "close",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  assert.ok(
    expectedStatuses.includes(response.status),
    `${url} returned ${response.status}: ${text.slice(0, 500)}`,
  );
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

await requestJson(`${apiBase}/api/health/live`);

const { today } = freshnessPolicy;
const startDate = shiftDate(today, 1 - lookbackDays);
const dateQuery = new URLSearchParams({
  dateDebut: startDate,
  dateFin: today,
});
const samples = [];

for (let index = 0; index < sampleCount; index += 1) {
  const nonce = `smoke=${Date.now()}-${index}`;
  const [healthResponse, departmentResponse, areaResponse] = await Promise.all([
    requestJson(`${apiBase}/api/health/statistics?${nonce}`, [200, 404]),
    requestJson(`${apiBase}/api/data/departement?${dateQuery}&${nonce}`),
    requestJson(`${apiBase}/api/data/area?${dateQuery}&${nonce}`),
  ]);

  if (healthResponse.status === 404) {
    assert.ok(allowMissingHealth, "The statistics health endpoint is missing");
  }

  const departmentDates = extractDates(departmentResponse.body, "Department");
  const areaDates = extractDates(areaResponse.body, "Area");
  assert.deepEqual(
    departmentDates,
    areaDates,
    "Department and area statistics expose different dates",
  );
  assert.ok(
    departmentResponse.body.every(
      ({ departements }) =>
        Array.isArray(departements) &&
        departements.length === expectedDepartmentCount,
    ),
    `A certified day does not contain ${expectedDepartmentCount} departments`,
  );

  const latestDate = departmentDates.at(-1);
  const lagDays = dateDifferenceInDays(latestDate, today);
  assert.ok(lagDays >= 0, `Statistics expose a future date: ${latestDate}`);
  assert.ok(
    lagDays <= maximumLagDays,
    `Statistics stop at ${latestDate} (${lagDays} days behind ${today})`,
  );

  const health = healthResponse.status === 200 ? healthResponse.body : null;
  if (health) {
    assert.equal(health.status, "ready", "The statistics cache is not ready");
    assert.equal(health.usable, true, "The statistics cache is not usable");
    assert.equal(health.fresh, true, "The statistics cache is stale");
    assert.equal(
      health.currentPublishedDate,
      latestDate,
      "The publication watermark and public statistics disagree",
    );
    assert.equal(
      health.latestDate,
      latestDate,
      "The health watermark and public statistics disagree",
    );
    assert.match(String(health.firstDate || ""), /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(
      Number.isInteger(health.dateCount) &&
        health.dateCount >= lookbackDays - maximumLagDays,
      "The statistics health reports insufficient date coverage",
    );
    assert.equal(health.departmentCount, expectedDepartmentCount);
    assert.equal(health.communeCount, expectedCommuneCount);
    assert.match(String(health.fingerprint || ""), /^[0-9a-f]{64}$/i);
    assert.ok(typeof health.mode === "string" && health.mode.length > 0);
    assert.ok(!Number.isNaN(Date.parse(health.loadedAt)));
    assert.equal(health.lastError, null);
  }

  samples.push({
    health,
    department: departmentResponse.body,
    area: areaResponse.body,
    latestDate,
  });
}

const reference = samples[0];
for (const sample of samples.slice(1)) {
  assert.deepEqual(
    sample.department,
    reference.department,
    "Department statistics differ between public API instances",
  );
  assert.deepEqual(
    sample.area,
    reference.area,
    "Area statistics differ between public API instances",
  );
  if (sample.health && reference.health) {
    for (const field of [
      "mode",
      "currentPublishedDate",
      "firstDate",
      "latestDate",
      "dateCount",
      "departmentCount",
      "communeCount",
      "fingerprint",
    ]) {
      assert.equal(
        sample.health[field],
        reference.health[field],
        `Statistics health field ${field} differs between API instances`,
      );
    }
  }
}

const communeQuery = new URLSearchParams({
  dateDebut: startDate.slice(0, 7),
  dateFin: today.slice(0, 7),
});
const { body: communeStatistics } = await requestJson(
  `${apiBase}/api/data/commune/${communeCode}?${communeQuery}`,
);
assert.equal(
  communeStatistics?.commune?.code,
  communeCode,
  "The lightweight commune statistics return the wrong commune",
);
const communeDates = extractDates(
  communeStatistics?.restrictions,
  `Commune ${communeCode}`,
);
assert.ok(
  communeDates.includes(reference.latestDate),
  `Commune statistics do not include certified date ${reference.latestDate}`,
);

console.log(
  JSON.stringify({
    status: "ok",
    startDate,
    latestDate: reference.latestDate,
    deadline: freshnessPolicy.deadline,
    afterDeadline: freshnessPolicy.afterDeadline,
    maximumLagDays,
    sampleCount,
    fingerprint: reference.health?.fingerprint ?? null,
    departmentCount: expectedDepartmentCount,
    communeCount: expectedCommuneCount,
    communeCode,
  }),
);
