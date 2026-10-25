import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectObservation, parseAlerts, parseArgs, parseTimeline, renderSummary,
  summarizeHealth, summarizeZones, writeObservation,
} from "./observe-scaling-5xx.mjs";

const START = Date.parse("2026-10-25T04:00:00Z");
const UNTIL = "2026-10-28T04:00:00.000Z";
const PUBLICATION = "2f73efe7-dc87-488b-9581-a134fbc72319";
const secret = "secret-token-person@example.com-192.0.2.1";
const timeline = `* \u001b[33mSat Oct 24 2026 23:21:48\u001b[0m - \u001b[32mAlert\u001b[0m - High 5xx Errors usage on container router triggered (value: 10 , limit: ≥ 5 ) <${secret}>\n* Sat Oct 24 2026 23:23:01 - Alert - High 5xx Errors usage on container router resolved (value: 0 , limit: ≥ 5 ) <https://example.com/?token=${secret}>\n* Sat Oct 24 2026 23:25:00 - Deployment - ${secret}\n`;
const alerts = `│ ID │ ACTIVE │ CONTAINER TYPE │ METRIC │ LIMIT │ REMIND EVERY │
│ al-8e52554d-19a5-4826-8d9a-5198c51df519 │ true │ web │ 5XX │ ≥ 5.00 (for 5m0s) │ 24h0m0s │
│ al-9342b46f-724d-48eb-b691-c313d1132725 │ true │ statcache │ memory │ ≥ 0.90 (for 10m0s) │ 24h0m0s │`;

function mockReads(overrides = {}) {
  const calls = [];
  return {
    calls,
    now: () => START,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      const path = new URL(url).pathname;
      if (overrides[path]) return overrides[path](url, options);
      if (path === "/api/zones/v2") return Response.json({
        zones: [
          { id: 7260843, type: "SUP", body: secret }, { id: 7260839, type: "SUP" },
          { id: 7260849, type: "SOU" }, { id: 7260836, type: "SOU" }, { id: 7260855, type: "AEP" },
        ],
        availability: Object.fromEntries(["SUP", "SOU", "AEP"].map((type) => [type, { status: "available", officialUrl: secret }])),
        token: secret,
      });
      return Response.json({ status: path.endsWith("/live") ? "ok" : "ready", usable: true, fresh: true,
        publication: { activeId: PUBLICATION, instances: { live: 3, activeReady: 3 }, token: secret },
        lastError: secret, signedUrl: `https://example.com/?secret=${secret}` });
    },
    execFileImpl: async (file, args, options) => {
      calls.push({ file, args, options });
      assert.equal(file, "scalingo");
      assert.deepEqual(args.slice(0, 2), ["--app", "preservonsleau-api-prod"]);
      assert.ok(options.timeout > 0 && options.timeout <= 20_000);
      assert.equal(options.killSignal, "SIGKILL");
      assert.equal(options.env.TZ, "UTC");
      return { stdout: args[2] === "timeline" ? timeline : alerts, stderr: secret };
    },
  };
}

test("arguments require an absolute output path and an exact UTC ISO deadline", () => {
  assert.deepEqual(parseArgs(["--output-dir", "/tmp/observer", "--until", "2026-10-28T04:00:00Z"]), {
    outputDir: "/tmp/observer", until: UNTIL,
  });
  for (const args of [[], ["--output-dir", "relative", "--until", UNTIL],
    ["--output-dir", "/tmp/observer", "--until", "2026-02-31T04:00:00Z"],
    ["--output-dir", "/tmp/observer", "--until", "2026-10-28T06:00:00+02:00"],
    ["--output-dir", "/tmp/observer", "--until", UNTIL, "--app", "different"],
    ["--output-dir", "/tmp/observer", "--output-dir", "/tmp/other", "--until", UNTIL]]) {
    assert.throws(() => parseArgs(args));
  }
});

test("timeline strips ANSI and retains only typed alert data with explicit UTC timestamps", () => {
  assert.deepEqual(parseTimeline(timeline), {
    events: [
      { timestamp: "2026-10-24T23:21:48.000Z", type: "triggered", metric: "5XX", value: 10 },
      { timestamp: "2026-10-24T23:23:01.000Z", type: "resolved", metric: "5XX", value: 0 },
    ], entryCount: 3, ignoredAlertCount: 0, potentiallyTruncated: false,
  });
  assert.doesNotMatch(JSON.stringify(parseTimeline(timeline)), /secret|example|https|192\.0/);
  assert.equal(parseTimeline(timeline.repeat(10)).potentiallyTruncated, true);
  assert.equal(parseTimeline(timeline.replace("5xx Errors", secret)).ignoredAlertCount, 1);
  assert.equal(parseTimeline(timeline.replace("Oct 24", "Feb 31")).ignoredAlertCount, 1);
  assert.throws(() => parseTimeline(secret));
});

test("alert configuration is parsed without retaining raw lines or notifier data", () => {
  assert.deepEqual(parseAlerts(alerts), [
    { active: true, container: "web", metric: "5XX", comparison: "gte", limit: 5, durationMs: 300_000, reminderMs: 86_400_000 },
    { active: true, container: "statcache", metric: "memory", comparison: "gte", limit: 0.9, durationMs: 600_000, reminderMs: 86_400_000 },
  ]);
  assert.throws(() => parseAlerts(alerts.replace("5XX", secret)));
  assert.throws(() => parseAlerts(alerts.replace("5m0s", "secret")));
  assert.throws(() => parseAlerts(secret));
});

test("body projections use allowlists and do not expose arbitrary remote strings", () => {
  assert.deepEqual(summarizeHealth({ status: "ready", usable: true, fresh: false, lastError: secret,
    publication: { activeId: secret, instances: { live: secret, activeReady: 3 } } }), {
    status: "ready", usable: true, fresh: false, publicationId: null, liveInstances: null, readyInstances: 3,
  });
  assert.throws(() => summarizeHealth({ status: secret }));
  assert.throws(() => summarizeZones({ zones: [{ id: secret, type: "SUP" }], availability: {} }));
});

test("a complete observation makes only read commands and pins the canary publication", async () => {
  const mocks = mockReads();
  const result = await collectObservation(UNTIL, mocks);
  assert.equal(result.status, "complete");
  assert.equal(result.state, "healthy");
  assert.equal(result.zones.publicationId, PUBLICATION);
  assert.equal(result.zones.publicationPinned, true);
  assert.deepEqual(result.zones.counts, { SUP: 2, SOU: 2, AEP: 1 });
  assert.deepEqual(result.zones.zoneIds, [7260836, 7260839, 7260843, 7260849, 7260855]);
  const canary = mocks.calls.find((call) => call.url?.includes("/zones/v2"));
  assert.equal(new URL(canary.url).searchParams.get("publicationId"), PUBLICATION);
  assert.deepEqual(mocks.calls.filter((call) => call.args).map((call) => call.args), [
    ["--app", "preservonsleau-api-prod", "timeline", "--per-page", "30"],
    ["--app", "preservonsleau-api-prod", "alerts"],
  ]);
  assert.doesNotMatch(JSON.stringify(result), /secret|example|https|192\.0|UserAgent|Body/);
  assert.doesNotMatch(renderSummary(result), /secret|example|https|192\.0/);
});

test("a server error is an observed degradation, never exposed as a raw response", async () => {
  const result = await collectObservation(UNTIL, mockReads({
    "/api/zones/v2": async () => Response.json({ message: secret }, { status: 500 }),
  }));
  assert.equal(result.status, "complete");
  assert.equal(result.state, "degraded");
  assert.equal(result.zones.httpStatus, 500);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("HTTP 200 still degrades the fixed canary when SUP/SOU are empty or unavailable", async () => {
  for (const body of [
    { zones: [], availability: { SUP: { status: "available" }, SOU: { status: "available" }, AEP: { status: "unavailable" } } },
    { zones: [{ id: 1, type: "SUP" }, { id: 2, type: "SOU" }], availability: { SUP: { status: "unavailable" }, SOU: { status: "available" }, AEP: { status: "unavailable" } } },
    { zones: [{ id: 1, type: "SUP" }, { id: 2, type: "SOU" }], availability: { SUP: { status: "available" }, SOU: { status: "unavailable" }, AEP: { status: "confirmed_none" } } },
  ]) {
    const result = await collectObservation(UNTIL, mockReads({ "/api/zones/v2": async () => Response.json(body) }));
    assert.equal(result.status, "complete");
    assert.equal(result.state, "degraded");
    assert.equal(result.zones.httpStatus, 200);
  }
});

test("the fixed canary accepts one SUP and one SOU and every known AEP state", async () => {
  for (const status of ["available", "unavailable", "confirmed_none"]) {
    const result = await collectObservation(UNTIL, mockReads({ "/api/zones/v2": async () => Response.json({
      zones: [{ id: 1, type: "SUP" }, { id: 2, type: "SOU" }],
      availability: { SUP: { status: "available" }, SOU: { status: "available" }, AEP: { status } },
    }) }));
    assert.equal(result.status, "complete");
    assert.equal(result.state, "healthy");
  }
});

test("unknown availability makes the canary observation incomplete and unknown", async () => {
  for (const type of ["SUP", "SOU", "AEP"]) {
    const availability = Object.fromEntries(["SUP", "SOU", "AEP"].map((name) => [name, { status: name === type ? secret : "available" }]));
    const result = await collectObservation(UNTIL, mockReads({ "/api/zones/v2": async () => Response.json({
      zones: [{ id: 1, type: "SUP" }, { id: 2, type: "SOU" }], availability,
    }) }));
    assert.equal(result.status, "incomplete");
    assert.equal(result.state, "unknown");
    assert.equal(result.zones.error, "invalid_response");
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
});

test("network and CLI failures produce incomplete sanitized observations", async () => {
  const mocks = mockReads({ "/api/health/cache": async () => { throw new TypeError(secret); } });
  mocks.execFileImpl = async () => { throw Object.assign(new Error(secret), { stderr: secret, killed: true }); };
  const result = await collectObservation(UNTIL, mocks);
  assert.equal(result.status, "incomplete");
  assert.equal(result.state, "unknown");
  assert.equal(result.health.cache.error, "network");
  assert.equal(result.timeline.error, "timeout");
  assert.equal(result.alerts.error, "timeout");
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("a malformed or oversized response cannot be reported as a healthy collection", async () => {
  for (const makeResponse of [() => new Response(secret), () => new Response("x".repeat(1_048_577))]) {
    const result = await collectObservation(UNTIL, mockReads({ "/api/health/live": async () => makeResponse() }));
    assert.equal(result.status, "incomplete");
    assert.equal(result.health.live.error, "invalid_response");
  }
});

test("an expired deadline performs no HTTP or CLI reads", async () => {
  const calls = [];
  const result = await collectObservation(UNTIL, { now: () => Date.parse(UNTIL),
    fetchImpl: async () => calls.push("HTTP"), execFileImpl: async () => calls.push("CLI") });
  assert.equal(result.status, "expired");
  assert.deepEqual(calls, []);
  assert.match(renderSummary(result), /Aucune lecture réseau/);
});

test("deadline reached after initial reads prevents the dependent canary request", async () => {
  const mocks = mockReads();
  let current = START;
  const fetchImpl = mocks.fetchImpl;
  mocks.now = () => current;
  mocks.fetchImpl = async (...args) => {
    const response = await fetchImpl(...args);
    current = Date.parse(UNTIL);
    return response;
  };
  const result = await collectObservation(UNTIL, mocks);
  assert.equal(result.status, "incomplete");
  assert.equal(result.zones.error, "deadline");
  assert.equal(mocks.calls.some((call) => call.url?.includes("/zones/v2")), false);
});

test("observations and summaries are atomically replaced in private local files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vigieau-5xx-test-"));
  try {
    const result = await collectObservation(UNTIL, mockReads());
    await writeObservation(directory, result);
    assert.deepEqual(JSON.parse(await readFile(join(directory, "latest.json"), "utf8")), result);
    assert.equal(await readFile(join(directory, "latest.txt"), "utf8"), renderSummary(result));
    assert.equal((await stat(join(directory, "latest.json"))).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(directory)).sort(), ["2026-10-25T04-00-00.000Z.json", "latest.json", "latest.txt"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
