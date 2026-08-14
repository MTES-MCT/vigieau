import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTarbesSituationExpectations,
  parseTarbesCheckMode,
  resolveTarbesLookupOutcome,
} from "./smoke-browser-tarbes.mjs";

test("Tarbes browser smoke defaults to adaptive mode", () => {
  assert.equal(parseTarbesCheckMode(undefined), "adaptive");
  assert.equal(parseTarbesCheckMode(""), "adaptive");
  assert.equal(parseTarbesCheckMode(" adaptive "), "adaptive");
});

test("Tarbes browser smoke preserves strict and skip modes", () => {
  assert.equal(parseTarbesCheckMode("strict"), "strict");
  assert.equal(parseTarbesCheckMode("skip"), "skip");
  assert.throws(
    () => parseTarbesCheckMode("permissive"),
    /must be adaptive, strict, or skip/,
  );
});

test("adaptive mode accepts precision and situation responses", () => {
  assert.equal(resolveTarbesLookupOutcome("adaptive", 409), "precision");
  assert.equal(resolveTarbesLookupOutcome("adaptive", 200), "situation");
  assert.throws(
    () => resolveTarbesLookupOutcome("adaptive", 500),
    /lookup returned 500/,
  );
});

test("strict mode still requires a precision response", () => {
  assert.equal(resolveTarbesLookupOutcome("strict", 409), "precision");
  assert.throws(
    () => resolveTarbesLookupOutcome("strict", 200),
    /lookup returned 200/,
  );
});

test("skip mode cannot execute the Tarbes lookup", () => {
  assert.throws(
    () => resolveTarbesLookupOutcome("skip", 409),
    /cannot run in skip mode/,
  );
});

test("builds dynamic render expectations for every water type", () => {
  assert.deepEqual(
    buildTarbesSituationExpectations([
      {
        id: 3,
        nom: "Zone AEP vigilance",
        type: "AEP",
        niveauGravite: "vigilance",
      },
      {
        id: "2",
        nom: "  Zone AEP crise  ",
        type: "AEP",
        niveauGravite: "crise",
      },
      {
        id: 4,
        nom: "Zone SUP",
        type: "SUP",
        niveauGravite: null,
      },
    ]),
    [
      {
        type: "AEP",
        zones: [
          {
            id: "2",
            name: "Zone AEP crise",
            type: "AEP",
            severityRank: 4,
          },
          {
            id: "3",
            name: "Zone AEP vigilance",
            type: "AEP",
            severityRank: 1,
          },
        ],
      },
      {
        type: "SUP",
        zones: [
          {
            id: "4",
            name: "Zone SUP",
            type: "SUP",
            severityRank: 0,
          },
        ],
      },
      { type: "SOU", zones: [] },
    ],
  );
});

test("rejects malformed Tarbes situation payloads", () => {
  assert.throws(
    () => buildTarbesSituationExpectations({ zones: [] }),
    /response is not a list/,
  );
  assert.throws(
    () =>
      buildTarbesSituationExpectations([
        { id: 1, type: "UNKNOWN", niveauGravite: null },
      ]),
    /unsupported water type/,
  );
  assert.throws(
    () =>
      buildTarbesSituationExpectations([
        { id: 1, type: "AEP", niveauGravite: "catastrophe" },
      ]),
    /unsupported severity/,
  );
});
