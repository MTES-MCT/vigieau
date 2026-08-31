import assert from "node:assert/strict";
import { classifyZonePublicationConvergence } from "./wait-zone-publication-policy.mjs";

const adminApiBase = (
  process.env.VIGIEAU_ADMIN_API_URL || "https://api.admin.vigieau.beta.gouv.fr"
).replace(/\/+$/, "");
const requestTimeoutMs = Number(process.env.VIGIEAU_SMOKE_TIMEOUT_MS || 15_000);
const convergenceTimeoutMs = Number(
  process.env.VIGIEAU_ZONE_CONVERGENCE_TIMEOUT_MS || 20 * 60 * 1000,
);
const pollMs = Number(process.env.VIGIEAU_ZONE_CONVERGENCE_POLL_MS || 30_000);

for (const [name, value] of [
  ["VIGIEAU_SMOKE_TIMEOUT_MS", requestTimeoutMs],
  ["VIGIEAU_ZONE_CONVERGENCE_TIMEOUT_MS", convergenceTimeoutMs],
  ["VIGIEAU_ZONE_CONVERGENCE_POLL_MS", pollMs],
]) {
  assert.ok(Number.isInteger(value) && value > 0, `${name} must be positive`);
}

const healthUrl = `${adminApiBase}/api/health/zone-publication`;
const startedAt = Date.now();
let attempt = 0;
let lastDiagnostic = null;
let stable = false;

const wait = (durationMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });

while (Date.now() - startedAt <= convergenceTimeoutMs) {
  attempt += 1;
  try {
    const response = await fetch(`${healthUrl}?smoke=${Date.now()}-${attempt}`, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const text = await response.text();
    if (response.status === 429 || response.status >= 500) {
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (body?.checks && typeof body.checks === "object") {
        const convergence = classifyZonePublicationConvergence(body);
        if (convergence.state === "blocked") {
          throw new Error(
            `Zone publication is ${convergence.reason || body.status}`,
          );
        }
        lastDiagnostic = {
          attempt,
          httpStatus: response.status,
          status: body.status,
          reason: convergence.reason,
        };
      } else {
        lastDiagnostic = {
          attempt,
          httpStatus: response.status,
          status: "network_retry",
          reason: text.slice(0, 200),
        };
      }
    } else {
      assert.equal(
        response.status,
        200,
        `${healthUrl} returned ${response.status}: ${text.slice(0, 500)}`,
      );
      const body = text ? JSON.parse(text) : null;
      const convergence = classifyZonePublicationConvergence(body);
      lastDiagnostic = {
        attempt,
        httpStatus: response.status,
        status: body.status,
        reason: convergence.reason,
      };
      if (convergence.state === "stable") {
        stable = true;
        console.log(
          JSON.stringify({
            status: "stable",
            attempts: attempt,
            elapsedMs: Date.now() - startedAt,
            businessDate: body.businessDate,
            historicStatus: body.historicStatus,
          }),
        );
        break;
      }
      if (convergence.state === "blocked") {
        throw new Error(
          `Zone publication is ${convergence.reason || body.status}`,
        );
      }
    }
  } catch (error) {
    if (
      error instanceof assert.AssertionError ||
      /Zone publication is /.test(String(error?.message || ""))
    ) {
      throw error;
    }
    lastDiagnostic = {
      attempt,
      httpStatus: null,
      status: "network_retry",
      reason: String(error?.message || error),
    };
  }

  const remainingMs = convergenceTimeoutMs - (Date.now() - startedAt);
  if (remainingMs <= 0) {
    break;
  }
  console.log(JSON.stringify({ status: "waiting", ...lastDiagnostic }));
  await wait(Math.min(pollMs, remainingMs));
}

assert.ok(
  stable,
  `Zone publication did not converge within ${convergenceTimeoutMs}ms: ${JSON.stringify(lastDiagnostic)}`,
);
