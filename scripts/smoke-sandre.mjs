import assert from "node:assert/strict";
import {
  assertSandreHealth,
  parseExpectedSandreModes,
} from "./smoke-sandre-policy.mjs";

const apiBase = (
  process.env.VIGIEAU_ADMIN_API_URL || "https://api.admin.vigieau.beta.gouv.fr"
).replace(/\/+$/, "");
const timeoutMs = Number(process.env.VIGIEAU_SMOKE_TIMEOUT_MS || 15_000);
const expectedModes = parseExpectedSandreModes(
  process.env.VIGIEAU_EXPECT_SANDRE_MODES,
);
const expectedDepartmentCount = Number(
  process.env.VIGIEAU_EXPECT_DEPARTMENT_COUNT || 101,
);

async function json(path, expectedStatuses = [200]) {
  const response = await fetch(`${apiBase}/api/${path}`, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  assert.ok(
    expectedStatuses.includes(response.status),
    `${path} returned ${response.status}: ${text.slice(0, 500)}`,
  );
  return text ? JSON.parse(text) : null;
}

const [references, synchronization] = await Promise.all([
  json("health/sandre-references"),
  json("health/sandre-synchronization", [200, 503]),
]);
const result = assertSandreHealth({
  references,
  synchronization,
  expectedModes,
  expectedDepartmentCount,
});
console.log(JSON.stringify({ status: "ok", ...result }));
