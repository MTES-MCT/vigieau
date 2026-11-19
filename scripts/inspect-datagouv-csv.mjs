import assert from "node:assert/strict";

// The smoke runs after checkout with Node alone. Fields may include commas,
// CRLF, escaped quotes and newlines (notably the descriptions of usages).
function* csvRows(text) {
  const field = /(?:"((?:[^"]|"")*)"|([^",\r\n]*))(,|\r\n|\n|\r|$)/gy;
  let row = [];
  while (field.lastIndex < text.length) {
    const match = field.exec(text);
    assert.ok(match, "Malformed CSV field");
    row.push(
      match[1] === undefined ? match[2] : match[1].replaceAll('""', '"'),
    );
    if (match[3] === ",") {
      if (field.lastIndex === text.length) {
        row.push("");
        yield row;
      }
    } else {
      yield row;
      row = [];
    }
  }
}

function verifyRows(text, columns, expected, { emptyAllowed = false } = {}) {
  const missing = new Set(expected.map((values) => JSON.stringify(values)));
  const rows = csvRows(text.replace(/^\uFEFF/, ""));
  const header = rows.next().value;
  if (!header && emptyAllowed) return { rowCount: 0, checked: 0 };
  assert.ok(header, "Empty CSV");
  const indexes = columns.map((column) => {
    const index = header.indexOf(column);
    assert.notEqual(index, -1, `Missing CSV column ${column}`);
    return index;
  });
  let rowCount = 0;
  for (const row of rows) {
    assert.equal(
      row.length,
      header.length,
      `Malformed CSV row ${rowCount + 2}`,
    );
    missing.delete(JSON.stringify(indexes.map((index) => row[index])));
    rowCount++;
  }
  assert.ok(rowCount > 0 || emptyAllowed, "The CSV has no data rows");
  assert.equal(
    missing.size,
    0,
    `Missing ${missing.size} values from the public API in CSV: ${missing.values().next().value}`,
  );
  return { rowCount, checked: expected.length };
}

export function verifyOrdersCsv(text, orders) {
  assert.ok(Array.isArray(orders), "Expected orders from the public API");
  return verifyRows(
    text,
    ["id", "numero", "date_debut"],
    orders.map((order) => [String(order.id), order.numero, order.dateDebut]),
  );
}

export function verifyRestrictionsCsv(text, zones) {
  const expected = zones.flatMap((zone) =>
    zone.usages.map((usage) => [
      String(zone.arrete.id),
      zone.departement,
      zone.type,
      zone.nom,
      zone.niveauGravite,
      usage.nom,
    ]),
  );
  const result = verifyRows(
    text,
    [
      "arrete.id",
      "zone.departement",
      "zone.type",
      "zone.nom",
      "niveau_gravite",
      "usage.u.nom",
    ],
    expected,
    { emptyAllowed: expected.length === 0 },
  );
  if (!expected.length)
    assert.equal(
      result.rowCount,
      0,
      "Unexpected restrictions without reference usages",
    );
  return result;
}
