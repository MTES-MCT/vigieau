import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

const maximumAttempts = 3;
const maximumRetryDelayMs = 2_000;
const transientStatuses = new Set([429, 502, 503, 504]);
const transientNetworkCodes = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function isNetworkError(error) {
  const code = error?.cause?.code || error?.code;
  return code
    ? transientNetworkCodes.has(code)
    : error instanceof TypeError && error.message === "fetch failed";
}

function isTransientResponse(response) {
  // A JSON 503 is an application health verdict, not a gateway outage.
  const applicationUnavailable =
    response.status === 503 &&
    /\bapplication\/(?:[\w.-]+\+)?json\b/i.test(
      response.headers.get("content-type") || "",
    );
  return transientStatuses.has(response.status) && !applicationUnavailable;
}

function retryDelay(response, fallbackMs) {
  const retryAfter = response?.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = /^\d+$/.test(retryAfter) ? Number(retryAfter) : NaN;
    const date = Number.isNaN(seconds) ? Date.parse(retryAfter) : NaN;
    if (Number.isFinite(seconds)) return seconds * 1_000;
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(fallbackMs, maximumRetryDelayMs);
}

export async function smokeFetch(
  input,
  init = {},
  { timeoutMs = 15_000, retryDelayMs = 500, fetchImpl = globalThis.fetch } = {},
) {
  assert.ok(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    "The smoke HTTP timeout must be a positive integer",
  );
  assert.ok(
    Number.isFinite(retryDelayMs) && retryDelayMs >= 0,
    "The smoke HTTP retry delay must be non-negative",
  );
  const request = input instanceof Request ? input : null;
  const callerSignal =
    init.signal === undefined ? request?.signal : init.signal;
  // Keep this deadline attached to the returned response, including its body.
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, deadline])
    : deadline;
  const method = (init.method || request?.method || "GET").toUpperCase();
  const attempts = ["GET", "HEAD"].includes(method) ? maximumAttempts : 1;
  const startedAt = performance.now();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal.throwIfAborted();
    let response;
    let failure;
    try {
      response = await fetchImpl(input, { ...init, signal });
    } catch (error) {
      signal.throwIfAborted();
      if (attempt === attempts || !isNetworkError(error)) throw error;
      failure = error;
    }
    if (response && (attempt === attempts || !isTransientResponse(response))) {
      return response;
    }

    const delayMs = retryDelay(response, retryDelayMs * attempt);
    if (performance.now() - startedAt + delayMs >= timeoutMs) {
      if (response) return response;
      throw failure;
    }
    await response?.body?.cancel();
    const url = new URL(request?.url || input);
    console.warn(
      `[smoke-http] ${method} ${url.origin}${url.pathname}: retry ${attempt + 1}/${attempts} in ${delayMs}ms after ${response ? `HTTP ${response.status}` : failure.cause?.code || failure.code || failure.message}`,
    );
    try {
      await sleep(delayMs, undefined, { signal });
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    }
  }
}
