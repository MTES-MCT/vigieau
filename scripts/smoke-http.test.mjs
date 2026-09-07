import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { smokeFetch } from "./smoke-http.mjs";

const url = "https://example.test/api/health/ready";
const networkFailure = () =>
  new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });

async function localServer(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("GET recovers from network failures in at most three attempts", async (t) => {
  t.mock.method(console, "warn", () => {});
  let attempts = 0;
  const signals = [];
  const expected = new Response("recovered");
  const response = await smokeFetch(
    url,
    {},
    {
      retryDelayMs: 0,
      fetchImpl: async (_input, init) => {
        signals.push(init.signal);
        attempts += 1;
        if (attempts < 3) throw networkFailure();
        return expected;
      },
    },
  );
  assert.equal(attempts, 3);
  assert.ok(signals.every((signal) => signal === signals[0]));
  assert.equal(response, expected);
  assert.equal(await response.text(), "recovered");
});

test("a permanent network failure still fails after three attempts", async (t) => {
  t.mock.method(console, "warn", () => {});
  let attempts = 0;
  const error = networkFailure();
  await assert.rejects(
    smokeFetch(
      url,
      {},
      {
        retryDelayMs: 0,
        fetchImpl: async () => {
          attempts += 1;
          throw error;
        },
      },
    ),
    (actual) => actual === error,
  );
  assert.equal(attempts, 3);
});

test("does not retry mutations or non-network errors", async () => {
  for (const [method, error] of [
    ["POST", networkFailure()],
    ["GET", new TypeError("Invalid URL")],
    [
      "GET",
      new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } }),
    ],
  ]) {
    let attempts = 0;
    await assert.rejects(
      smokeFetch(
        url,
        { method },
        {
          retryDelayMs: 0,
          fetchImpl: async () => {
            attempts += 1;
            throw error;
          },
        },
      ),
      (actual) => actual === error,
    );
    assert.equal(attempts, 1);
  }
});

test("retries transient HTTP responses and cancels their unused bodies", async (t) => {
  t.mock.method(console, "warn", () => {});
  for (const status of [429, 502, 503, 504]) {
    let cancelled = false;
    let attempts = 0;
    const headers = { Range: "bytes=0-63" };
    const response = await smokeFetch(
      url,
      { method: "GET", headers },
      {
        retryDelayMs: 0,
        fetchImpl: async (_input, init) => {
          assert.deepEqual(init.headers, headers);
          attempts += 1;
          return attempts === 1
            ? new Response(
                new ReadableStream({
                  cancel() {
                    cancelled = true;
                  },
                }),
                {
                  status,
                  headers: { "content-type": "text/html" },
                },
              )
            : new Response("recovered");
        },
      },
    );
    assert.equal(attempts, 2);
    assert.equal(cancelled, true);
    assert.equal(await response.text(), "recovered");
  }
});

test("the final failing HTTP response remains readable", async (t) => {
  t.mock.method(console, "warn", () => {});
  let attempts = 0;
  const response = await smokeFetch(
    url,
    {},
    {
      retryDelayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        return new Response("still unavailable", { status: 502 });
      },
    },
  );
  assert.equal(attempts, 3);
  assert.equal(response.status, 502);
  assert.equal(await response.text(), "still unavailable");
});

test("semantic JSON 503 health failures are never retried or consumed", async () => {
  for (const contentType of [
    "application/json; charset=utf-8",
    "application/problem+json",
  ]) {
    let attempts = 0;
    const body = {
      status: "degraded",
      usable: false,
      lastError: "stale cache",
    };
    const response = await smokeFetch(
      url,
      {},
      {
        retryDelayMs: 0,
        fetchImpl: async () => {
          attempts += 1;
          return new Response(JSON.stringify(body), {
            status: 503,
            headers: { "content-type": contentType },
          });
        },
      },
    );
    assert.equal(attempts, 1);
    assert.equal(response.status, 503);
    assert.equal(response.bodyUsed, false);
    assert.deepEqual(await response.json(), body);
  }
});

test("non-transient HTTP failures are returned without retry", async () => {
  for (const status of [400, 401, 403, 404, 409, 500]) {
    let attempts = 0;
    const response = await smokeFetch(
      url,
      {},
      {
        retryDelayMs: 0,
        fetchImpl: async () => {
          attempts += 1;
          return new Response("failure", { status });
        },
      },
    );
    assert.equal(attempts, 1);
    assert.equal(await response.text(), "failure");
  }
});

test("HEAD Request inputs retain their method and support network retry", async (t) => {
  t.mock.method(console, "warn", () => {});
  let attempts = 0;
  const request = new Request(url, { method: "HEAD" });
  const response = await smokeFetch(
    request,
    {},
    {
      retryDelayMs: 0,
      fetchImpl: async (input) => {
        assert.equal(input.method, "HEAD");
        attempts += 1;
        if (attempts === 1) throw networkFailure();
        return new Response(null);
      },
    },
  );
  assert.equal(attempts, 2);
  assert.equal(response.status, 200);
});

test("Retry-After beyond the total budget returns the last response untouched", async () => {
  for (const retryAfter of [
    "60",
    new Date(Date.now() + 60_000).toUTCString(),
  ]) {
    let attempts = 0;
    const expected = new Response("busy", {
      status: 429,
      headers: { "retry-after": retryAfter },
    });
    const response = await smokeFetch(
      url,
      {},
      {
        timeoutMs: 15_000,
        fetchImpl: async () => {
          attempts += 1;
          return expected;
        },
      },
    );
    assert.equal(attempts, 1);
    assert.equal(response, expected);
    assert.equal(response.bodyUsed, false);
    assert.equal(await response.text(), "busy");
  }
});

test("Retry-After within the budget is respected before retrying", async (t) => {
  t.mock.method(console, "warn", () => {});
  let attempts = 0;
  const startedAt = performance.now();
  const response = await smokeFetch(
    url,
    {},
    {
      timeoutMs: 5_000,
      retryDelayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response(null, { status: 429, headers: { "retry-after": "1" } })
          : new Response("recovered");
      },
    },
  );
  assert.equal(attempts, 2);
  assert.ok(performance.now() - startedAt >= 900);
  assert.equal(await response.text(), "recovered");
});

test("the total timeout aborts a hanging connection without resetting the budget", async (t) => {
  let attempts = 0;
  const baseUrl = await localServer(t, () => {
    attempts += 1;
  });
  await assert.rejects(smokeFetch(baseUrl, {}, { timeoutMs: 75 }), {
    name: "TimeoutError",
  });
  assert.equal(attempts, 1);
});

test("the deadline remains active while the caller reads the response body", async (t) => {
  const baseUrl = await localServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"status":');
  });
  const response = await smokeFetch(baseUrl, {}, { timeoutMs: 100 });
  await assert.rejects(response.text(), { name: "TimeoutError" });
});

test("an already aborted caller signal is preserved and never fetched", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled by caller");
  controller.abort(reason);
  let attempts = 0;
  await assert.rejects(
    smokeFetch(
      new Request(url, { signal: controller.signal }),
      {},
      {
        fetchImpl: async () => {
          attempts += 1;
        },
      },
    ),
    (error) => error === reason,
  );
  assert.equal(attempts, 0);
});

test("caller cancellation during backoff stops further attempts", async (t) => {
  t.mock.method(console, "warn", () => {});
  const controller = new AbortController();
  const reason = new Error("cancelled by caller");
  let attempts = 0;
  const pending = smokeFetch(
    url,
    { signal: controller.signal },
    {
      fetchImpl: async () => {
        attempts += 1;
        throw networkFailure();
      },
    },
  );
  await setImmediate();
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(attempts, 1);
});

test("caller cancellation remains active after receiving response headers", async (t) => {
  const baseUrl = await localServer(t, (_request, response) => {
    response.writeHead(200);
    response.write("partial");
  });
  const controller = new AbortController();
  const response = await smokeFetch(baseUrl, { signal: controller.signal });
  controller.abort();
  await assert.rejects(response.text(), { name: "AbortError" });
});
