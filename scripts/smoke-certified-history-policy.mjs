import assert from "node:assert/strict";
import { createHash } from "node:crypto";

function dateRange(from, through) {
  const dates = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${through}T00:00:00.000Z`);
  assert.ok(
    !Number.isNaN(cursor.getTime()) &&
      !Number.isNaN(end.getTime()) &&
      cursor <= end,
    "Certified history canary range is invalid",
  );
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export function assertCertifiedHistoryCanary({
  payload,
  communeCode,
  dateFrom,
  dateThrough,
  expectedDigest,
}) {
  assert.equal(
    payload?.commune?.code,
    communeCode,
    "The certified history canary returns the wrong commune",
  );
  assert.ok(
    Array.isArray(payload?.restrictions),
    "The certified history canary restrictions are not a list",
  );
  const expected = dateRange(dateFrom, dateThrough);
  assert.match(
    String(expectedDigest || ""),
    /^[a-f0-9]{64}$/,
    "The certified history canary digest is invalid",
  );
  const byDate = new Map();
  for (const restriction of payload.restrictions) {
    if (!expected.includes(restriction?.date)) continue;
    assert.ok(
      !byDate.has(restriction.date),
      `Certified history canary contains duplicate date ${restriction.date}`,
    );
    for (const type of ["SOU", "SUP", "AEP"]) {
      assert.ok(
        Object.hasOwn(restriction, type),
        `Certified history canary ${restriction.date} is missing ${type}`,
      );
      assert.ok(
        restriction[type] === null ||
          ["vigilance", "alerte", "alerte_renforcee", "crise"].includes(
            restriction[type],
          ),
        `Certified history canary ${restriction.date}/${type} is invalid`,
      );
    }
    byDate.set(restriction.date, restriction);
  }
  const missing = expected.filter((date) => !byDate.has(date));
  assert.deepEqual(
    missing,
    [],
    `Certified history canary is missing ${missing.length} date(s): ${missing.slice(0, 5).join(", ")}`,
  );
  const canonical = expected
    .map((date) => {
      const restriction = byDate.get(date);
      return JSON.stringify([
        date,
        restriction.SOU,
        restriction.SUP,
        restriction.AEP,
      ]);
    })
    .join("\n");
  const digest = createHash("sha256").update(canonical).digest("hex");
  assert.equal(
    digest,
    expectedDigest,
    "Certified history canary values differ from the certified source",
  );
  return {
    communeCode,
    dateFrom,
    dateThrough,
    certifiedDayCount: expected.length,
    digest,
  };
}
