import assert from "node:assert/strict";
import test from "node:test";
import {
  verifyOrdersCsv,
  verifyRestrictionsCsv,
} from "./inspect-datagouv-csv.mjs";
import { classifyDeep } from "./production-incidents-policy.mjs";

const order = { id: 38524, numero: '63, "test"', dateDebut: "2026-11-19" };
const header = "id,numero,date_debut,date_fin";
test("checks all active order IDs, numbers and effective dates despite multiline CSV fields", () => {
  const csv = `\uFEFF${header}\r\n1,"ancien\r\ntexte",2026-07-01,2027-01-01\r\n38524,"63, ""test""",2026-11-19,\r\n`;
  assert.deepEqual(verifyOrdersCsv(csv, [order]), { rowCount: 2, checked: 1 });
  assert.throws(
    () => verifyOrdersCsv(csv.replace("38524,", "38525,"), [order]),
    /Missing 1 values/,
  );
  assert.throws(
    () => verifyOrdersCsv(csv.replace("2026-11-19", "2026-10-19"), [order]),
    /Missing 1 values/,
  );
  assert.throws(
    () => verifyOrdersCsv(csv.replace('""test"""', '""test""'), [order]),
    /Malformed CSV/,
  );
});

const fields =
  "zone.departement,zone.type,zone.nom,niveau_gravite,arrete.id,usage.u.nom";
const zone = {
  arrete: { id: 38524 },
  departement: "63",
  type: "SOU",
  nom: "Sancy",
  niveauGravite: "alerte",
  usages: [{ nom: "Arrosage" }],
};
test("verifies published usages against the independent current zones API", () => {
  const csv = fields + "\n63,SOU,Sancy,alerte,38524,Arrosage";
  assert.deepEqual(verifyRestrictionsCsv(csv, [zone]), {
    rowCount: 1,
    checked: 1,
  });
  assert.throws(
    () => verifyRestrictionsCsv(csv.replace("alerte", "crise"), [zone]),
    /Missing 1 values/,
  );
  assert.throws(
    () => verifyRestrictionsCsv(csv.replace("Arrosage", "Piscines"), [zone]),
    /Missing 1 values/,
  );
  assert.throws(
    () =>
      verifyRestrictionsCsv(csv.replace("arrete.id", "arrete.numero"), [zone]),
    /Missing CSV column/,
  );
  assert.deepEqual(verifyRestrictionsCsv("", []), { rowCount: 0, checked: 0 });
  assert.throws(
    () => verifyRestrictionsCsv(csv, []),
    /Unexpected restrictions/,
  );
});

test("simultaneous failures of current and historical exports still alert on the CSV", () => {
  for (const zip of [
    "Communes en restrictions - 2026 is 26.1 hours old",
    "The ZIP member maximum inspected date is 2026-09-15",
  ]) {
    const failure = classifyDeep("datagouv", {
      code: 1,
      output: `Error: Arrêtés CSV: Missing 1 values | communes: ${zip}`,
    });
    assert.equal(failure.key, "deep-datagouv");
    assert.equal(failure.publicationAgeFailure, false);
  }
});
