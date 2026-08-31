import assert from "node:assert/strict";
import test from "node:test";
import { assertCertifiedHistoryCanary } from "./smoke-certified-history-policy.mjs";

const certifiedDigest =
  "9a79da0dcea956455e1da05e271504f6163ef9d47be86dbe35ff6dfd1df1b255";
const complete = Array.from({ length: 48 }, (_, index) => {
  const date = new Date("2026-07-11T00:00:00.000Z");
  date.setUTCDate(date.getUTCDate() + index);
  const civilDate = date.toISOString().slice(0, 10);
  return {
    date: civilDate,
    SOU: null,
    SUP: civilDate === "2026-08-01" ? null : "vigilance",
    AEP: civilDate === "2026-08-01" ? null : "vigilance",
  };
});

test("accepts the complete certified Coupvray interval", () => {
  assert.deepEqual(
    assertCertifiedHistoryCanary({
      payload: { commune: { code: "77132" }, restrictions: complete },
      communeCode: "77132",
      dateFrom: "2026-07-11",
      dateThrough: "2026-08-27",
      expectedDigest: certifiedDigest,
    }),
    {
      communeCode: "77132",
      dateFrom: "2026-07-11",
      dateThrough: "2026-08-27",
      certifiedDayCount: 48,
      digest: certifiedDigest,
    },
  );
});

test("rejects the exact historic gap that previously regressed", () => {
  assert.throws(
    () =>
      assertCertifiedHistoryCanary({
        payload: {
          commune: { code: "77132" },
          restrictions: complete.filter(({ date }) => date !== "2026-08-01"),
        },
        communeCode: "77132",
        dateFrom: "2026-07-11",
        dateThrough: "2026-08-27",
        expectedDigest: certifiedDigest,
      }),
    /missing 1 date.*2026-08-01/,
  );
});

test("rejects present dates whose certified levels were emptied", () => {
  assert.throws(
    () =>
      assertCertifiedHistoryCanary({
        payload: {
          commune: { code: "77132" },
          restrictions: complete.map(({ date }) => ({
            date,
            SOU: null,
            SUP: null,
            AEP: null,
          })),
        },
        communeCode: "77132",
        dateFrom: "2026-07-11",
        dateThrough: "2026-08-27",
        expectedDigest: certifiedDigest,
      }),
    /values differ from the certified source/,
  );
});
