import test from "node:test";
import assert from "node:assert/strict";
import { CAUSES, INCIDENT_LABEL, MARKER, advanceIncident, classifyDeep, combineObservations, incidentBody, observation, parseIncident, safeFailureHint } from "./production-incidents-policy.mjs";
import { GitHubIncidents } from "./production-incidents-github.mjs";
import { collectLight, main, runDeep } from "./production-incidents.mjs";

const failure = observation("business-clock", "failure", "Clock stale");
const success = { ...failure, status: "success" };
function context(run = 1, hours = 0) {
  return { now: new Date(Date.parse("2026-09-07T08:00:00Z") + hours * 3_600_000),
    observationId: `${run}:1`, assignee: "sghribi", runUrl: `https://github.com/MTES-MCT/vigieau/actions/runs/${run}`, sha: "a".repeat(40) };
}

function mockGitHub() {
  const issues = [];
  const comments = [];
  const writes = [];
  let ambiguousIssue = false;
  let ambiguousComment = false;
  let rejectComment = false;
  const api = new GitHubIncidents({ token: "test-secret", repository: "MTES-MCT/vigieau", fetchImpl: async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace("/repos/MTES-MCT/vigieau", "");
    const body = init.body ? JSON.parse(init.body) : null;
    if (init.method !== "GET") writes.push({ path, method: init.method, body });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === "/labels") return json([{ name: INCIDENT_LABEL }]);
    if (path === "/issues" && init.method === "GET") return json(issues);
    if (path === "/issues" && init.method === "POST") {
      const issue = { number: issues.length + 1, state: "open", user: { login: "github-actions[bot]" }, ...body };
      issues.push(issue);
      if (ambiguousIssue) { ambiguousIssue = false; throw new Error("Response lost"); }
      return json(issue, 201);
    }
    const commentMatch = path.match(/^\/issues\/(\d+)\/comments$/);
    if (commentMatch) {
      if (init.method === "GET") return json(comments.filter((comment) => comment.issue === Number(commentMatch[1])));
      if (rejectComment) return json({}, 503);
      const comment = { body: body.body, issue: Number(commentMatch[1]), user: { login: "github-actions[bot]" } };
      comments.push(comment);
      if (ambiguousComment) { ambiguousComment = false; throw new Error("Response lost"); }
      return json(comment, 201);
    }
    const issueMatch = path.match(/^\/issues\/(\d+)$/);
    if (issueMatch && init.method === "PATCH") {
      const issue = issues.find((row) => row.number === Number(issueMatch[1]));
      Object.assign(issue, body);
      return json(issue);
    }
    if (path === "/check-runs") return json(body, 201);
    throw new Error(`Unhandled mock request ${init.method} ${path}`);
  } });
  return { api, issues, comments, writes,
    loseIssueResponse() { ambiguousIssue = true; }, loseCommentResponse() { ambiguousComment = true; },
    failComments(value) { rejectComment = value; } };
}

test("persistent failure opens once and does not repeatedly comment", async () => {
  const mock = mockGitHub();
  await mock.api.reconcile([failure], context(1));
  const initialBody = mock.issues[0].body;
  const openingWriteCount = mock.writes.length;
  await mock.api.reconcile([failure], context(2, 0.25));
  await mock.api.reconcile([failure], context(3, 0.5));
  assert.equal(mock.issues.length, 1);
  assert.equal(mock.comments.length, 0);
  assert.equal(mock.writes.length, openingWriteCount, "Identical failures must not PATCH or POST anything");
  assert.equal(mock.issues[0].body, initialBody);
  assert.equal(parseIncident(mock.issues[0]).lastSeenAt, context(1).now.toISOString());
  assert.deepEqual(mock.issues[0].assignees, ["sghribi"]);
  assert.equal(parseIncident(mock.issues[0]).status, "open");
  assert.match(mock.issues[0].body, /Impact :/);
  assert.match(mock.issues[0].body, /Action :/);
  assert.match(mock.issues[0].body, /Clock stale/);
  assert.match(mock.issues[0].body, /Derniere observation persistee/);
  assert.match(mock.issues[0].body, /actions\/workflows\/production-incidents.yml/);
});

test("changing diagnostics alone do not notify a persistent cause before its daily reminder", async () => {
  const mock = mockGitHub();
  await mock.api.reconcile([failure], context(1));
  const openingWriteCount = mock.writes.length;
  for (const [run, hours] of [[2, 1], [3, 12], [4, 23.99]]) {
    await mock.api.reconcile([{ ...failure, detail: `Different diagnostic at run ${run}` }], context(run, hours));
  }
  assert.equal(mock.writes.length, openingWriteCount);
  assert.equal(parseIncident(mock.issues[0]).lastObservationId, context(1).observationId);
  await mock.api.reconcile([failure], context(5, 24));
  assert.equal(mock.comments.length, 1);
  assert.match(mock.comments[0].body, /RAPPEL QUOTIDIEN/);
});

test("two consecutive complete successes notify once and close", async () => {
  const mock = mockGitHub();
  await mock.api.reconcile([failure], context(1));
  await mock.api.reconcile([success], context(2, 0.25));
  assert.equal(mock.issues[0].state, "open");
  await mock.api.reconcile([success], context(3, 0.5));
  const recoveryWriteCount = mock.writes.length;
  await mock.api.reconcile([success], context(4, 0.75));
  assert.equal(mock.issues[0].state, "closed");
  assert.equal(mock.comments.length, 1);
  assert.match(mock.comments[0].body, /RETABLI/);
  assert.equal(mock.writes.length, recoveryWriteCount, "Already recovered issues must not be updated every poll");
});

test("unknown and pending observations break recovery sequence without healing", async () => {
  for (const status of ["unknown", "pending"]) {
    const mock = mockGitHub();
    await mock.api.reconcile([failure], context(1));
    await mock.api.reconcile([success], context(2));
    await mock.api.reconcile([{ ...failure, status }], context(3));
    await mock.api.reconcile([success], context(4));
    assert.equal(mock.issues[0].state, "open");
    assert.equal(parseIncident(mock.issues[0]).recoveryCount, 1);
    assert.equal(mock.comments.length, 0);
  }
});

test("rerunning an observation cannot count twice toward recovery", async () => {
  const mock = mockGitHub();
  await mock.api.reconcile([failure], context(1));
  await mock.api.reconcile([success], context(2));
  await mock.api.reconcile([success], context(2));
  assert.equal(mock.issues[0].state, "open");
  assert.equal(parseIncident(mock.issues[0]).recoveryCount, 1);
});

test("escalation and daily reminder are bounded and recovery reuses the cause", async () => {
  const mock = mockGitHub();
  const warning = { ...failure, severity: "warning" };
  await mock.api.reconcile([warning], context(1));
  await mock.api.reconcile([failure], context(2, 1));
  await mock.api.reconcile([failure], context(3, 2));
  assert.equal(mock.comments.length, 1);
  await mock.api.reconcile([failure], context(4, 25));
  await mock.api.reconcile([failure], context(5, 26));
  assert.equal(mock.comments.length, 2);
  await mock.api.reconcile([success], context(6, 27));
  await mock.api.reconcile([success], context(7, 28));
  await mock.api.reconcile([failure], context(8, 29));
  assert.equal(mock.issues.length, 1);
  assert.equal(mock.issues[0].state, "open");
  assert.match(mock.comments.at(-1).body, /NOUVEL EPISODE/);
});

test("ambiguous issue and transition POSTs reconcile instead of duplicating", async () => {
  const mock = mockGitHub();
  mock.loseIssueResponse();
  await mock.api.reconcile([failure], context(1));
  await mock.api.reconcile([success], context(2));
  mock.loseCommentResponse();
  await mock.api.reconcile([success], context(3));
  assert.equal(mock.issues.length, 1);
  assert.equal(mock.comments.length, 1);
  assert.equal(mock.issues[0].state, "closed");
});

test("failed notification is persisted pending, fails collection, then retries exactly once", async () => {
  const mock = mockGitHub();
  await mock.api.reconcile([failure], context(1));
  await mock.api.reconcile([success], context(2));
  mock.failComments(true);
  await assert.rejects(mock.api.reconcile([success], context(3)), /503/);
  assert.equal(mock.issues[0].state, "open");
  assert.equal(parseIncident(mock.issues[0]).pendingTransition.kind, "recovery");
  mock.failComments(false);
  await mock.api.reconcile([success], context(4));
  assert.equal(mock.comments.length, 1);
  assert.equal(mock.issues[0].state, "closed");
});

test("manual closure is reopened on failure, not treated as recovery", async () => {
  const mock = mockGitHub();
  await mock.api.reconcile([failure], context(1));
  mock.issues[0].state = "closed";
  const beforeReopening = mock.writes.length;
  await mock.api.reconcile([failure], context(2));
  assert.equal(mock.issues[0].state, "open");
  assert.equal(mock.comments.length, 0);
  assert.deepEqual(mock.writes.slice(beforeReopening).map(({ method, body }) => ({ method, body })),
    [{ method: "PATCH", body: { state: "open" } }]);
});

test("untrusted and corrupt incident metadata fail closed", () => {
  const state = advanceIncident(null, failure, context());
  const issue = { number: 1, user: { login: "attacker" }, body: incidentBody(state, context().runUrl) };
  assert.throws(() => parseIncident(issue), /Untrusted/);
  issue.user.login = "github-actions[bot]";
  issue.body = `<!-- ${MARKER}\n{}\n-->`;
  assert.throws(() => parseIncident(issue), /Invalid/);
});

test("issue listing paginates without relying on search indexing", async () => {
  const calls = [];
  const api = new GitHubIncidents({ token: "x", repository: "org/repo", fetchImpl: async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(new URL(url).searchParams.get("page") === "1" ? Array.from({ length: 100 }, (_, number) => ({ number })) : [{ number: 101 }]));
  } });
  assert.equal((await api.list("/issues?state=all")).length, 101);
  assert.equal(calls.length, 2);
});

test("health failures remain explicit red check-runs and unknown is never success", async () => {
  const mock = mockGitHub();
  await mock.api.publishChecks([failure, success, { ...failure, status: "unknown" }, { ...failure, status: "pending" }], context());
  assert.deepEqual(mock.writes.map((write) => write.body.conclusion), ["failure", "success", "failure", "neutral"]);
});

test("shared historical cause deduplicates without suppressing independent admin failure", () => {
  const statistics = classifyDeep("statistics", { code: 1, output: "Certified history canary is missing 4 dates" });
  const datagouv = classifyDeep("datagouv", { code: 1, output: "The ZIP member maximum inspected date is 2026-07-11, expected 2026-09-06" });
  const admin = observation("admin-api", "failure", "HTTP 503");
  const results = combineObservations([admin], [statistics, datagouv]);
  assert.deepEqual(results.map((item) => item.key), ["admin-api", "certified-history"]);
  assert.equal(classifyDeep("datagouv", { code: 1, output: "A resource is missing" }).key, "deep-datagouv");
});

test("history recovery requires both original deep contracts to succeed", () => {
  const good = classifyDeep("statistics", { code: 0 });
  assert.equal(combineObservations([], [good, classifyDeep("datagouv", { code: 1 })]).at(-1).status, "pending");
  assert.equal(combineObservations([], [good, classifyDeep("datagouv", { code: 0 })]).at(-1).status, "success");
});

function zoneHealth(status = "healthy", overrides = {}) {
  return { status, serving: true, businessDate: "2026-09-07", checks: {
    enabled: true, automaticPublishing: true, clock: true, activeServing: true,
    activeCurrent: true, candidateClear: true, legacyPromotion: true,
    currentStatistics: true, currentSnapshot: true, certifiedRun: true, recentProgress: true,
  }, ...overrides };
}

function healthyResponse(url) {
  if (!url.includes("/api/")) return new Response("<html></html>", { headers: { "content-type": "text/html" } });
  let body;
  if (url.endsWith("/external-publications")) body = { status: "healthy", failedResourceCount: 0, networkRetry: null,
    historicExport: { status: "ready", scheduledFor: "2026-09-07" }, lastRun: { status: "succeeded", scheduledFor: "2026-09-07" } };
  else if (url.endsWith("/data/status")) body = { historicComplete: true, historicDirtyFrom: null, historicDirtyThrough: null };
  else if (url.endsWith("/zone-publication")) body = zoneHealth();
  else body = { status: url.endsWith("/live") ? "ok" : /clock|zone-publication/.test(url) ? "healthy" : "ready", usable: true, fresh: true,
    currentFresh: true, publicationDeadline: "06:00", expectedPublishedDate: "2026-09-07", currentPublishedDate: "2026-09-07" };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

test("lightweight checks enforce contracts, retaining updating as pending", async () => {
  const rows = await collectLight({ now: context().now, fetchImpl: async (url) => {
    if (url.endsWith("/zone-publication")) return new Response(JSON.stringify(zoneHealth("updating")), { headers: { "content-type": "application/json" } });
    return healthyResponse(url);
  } });
  assert.equal(rows.length, 9);
  assert.equal(rows.filter((row) => row.status === "success").length, 8);
  assert.equal(rows.find((row) => row.key === "zone-publication").status, "pending");
  assert.equal(rows.some((row) => row.key === "certified-history"), false);
});

test("updating publication must remain served, progress recently and meet the Paris grace deadline", async () => {
  const cases = [
    [zoneHealth("updating"), "2026-09-07T08:00:00Z", "pending"],
    [zoneHealth("updating", { serving: false }), "2026-09-07T08:00:00Z", "failure"],
    [zoneHealth("updating", { checks: { ...zoneHealth().checks, recentProgress: false } }), "2026-09-07T08:00:00Z", "failure"],
    [zoneHealth("stale"), "2026-09-07T08:00:00Z", "failure"],
    [zoneHealth("updating", { businessDate: "2026-09-06" }), "2026-09-07T04:30:00Z", "pending"],
    [zoneHealth("updating", { businessDate: "2026-09-06" }), "2026-09-07T05:00:00Z", "failure"],
  ];
  for (const [body, stamp, expected] of cases) {
    const rows = await collectLight({ now: new Date(stamp), fetchImpl: async (url) => url.endsWith("/zone-publication")
      ? new Response(JSON.stringify(body)) : healthyResponse(url) });
    assert.equal(rows.find((row) => row.key === "zone-publication").status, expected, `${body.status} at ${stamp}`);
  }
});

test("live September 7 incomplete history and sparse exports produce one cause while current service stays healthy", async () => {
  const light = await collectLight({ now: context().now, fetchImpl: async (url) => {
    if (url.endsWith("/data/status")) return new Response(JSON.stringify({ status: "ready", usable: true, fresh: true,
      currentFresh: true, historicComplete: false, historicDirtyFrom: "2026-07-11", historicDirtyThrough: "2026-08-31" }));
    if (url.endsWith("/external-publications")) return new Response(JSON.stringify({ status: "stale", failedResourceCount: 0,
      lastRun: { scheduledFor: "2026-09-04", status: "succeeded" }, networkRetry: null,
      historicExport: { status: "blocked", blocker: "sparse_statistic_cache", scheduledFor: "2026-09-07", blockingAgeSeconds: 10178 } }));
    return healthyResponse(url);
  } });
  const deep = [classifyDeep("statistics", { code: 1, output: "AssertionError [ERR_ASSERTION]: Certified history canary is missing 52 dates" }),
    classifyDeep("admin", { code: 1, output: "AssertionError [ERR_ASSERTION]: Unsupported healthy historic status incomplete" }),
    classifyDeep("datagouv", { code: 1, output: "AssertionError [ERR_ASSERTION]: Communes en restrictions is 75.0 hours old" })];
  const rows = combineObservations(light, deep);
  assert.deepEqual(rows.filter((row) => row.status === "failure").map((row) => row.key), ["certified-history"]);
  assert.equal(rows.find((row) => row.key === "statistics-cache").status, "success");
  assert.equal(rows.find((row) => row.key === "admin-api").status, "success");
  assert.match(rows.find((row) => row.key === "certified-history").detail, /2026-07-11 au 2026-08-31 : 52 dates civiles/);
});

test("cache ready but unusable cannot heal and statistics deadline stays Paris based", async () => {
  const rows = await collectLight({ now: context().now, fetchImpl: async (url) => {
    if (url.endsWith("/health/cache")) return new Response(JSON.stringify({ status: "ready", usable: false, fresh: true }));
    if (url.endsWith("/health/statistics")) return new Response(JSON.stringify({ status: "ready", usable: true, fresh: true,
      currentFresh: true, publicationDeadline: "06:00", expectedPublishedDate: "2026-09-06", currentPublishedDate: "2026-09-06" }));
    return healthyResponse(url);
  } });
  assert.equal(rows.find((row) => row.key === "public-cache").status, "failure");
  assert.equal(rows.find((row) => row.key === "public-cache").severity, "critical");
  assert.equal(rows.find((row) => row.key === "statistics-cache").status, "failure");
});

test("certified overlay covering the dirty range defers recovery to both deep canaries", async () => {
  const body = { historicComplete: false, historicDirtyFrom: "2026-07-11", historicDirtyThrough: "2026-08-31",
    certifiedHistoryRepair: { id: "repair-id", sourceRunId: "source-run-id", publicationRevision: "42", activatedAt: "2026-09-07T07:00:00Z",
      from: "2026-07-11", through: "2026-08-31" } };
  const light = await collectLight({ now: context().now, fetchImpl: async (url) => url.endsWith("/data/status")
    ? new Response(JSON.stringify(body)) : healthyResponse(url) });
  assert.equal(light.some((row) => row.key === "certified-history"), false);
  const recovered = combineObservations(light, [classifyDeep("statistics", { code: 0 }), classifyDeep("datagouv", { code: 0 })]);
  const history = recovered.find((row) => row.key === "certified-history");
  const state = advanceIncident(null, observation("certified-history", "failure", "Incomplete history"), context(1));
  const first = advanceIncident(state, history, context(2));
  assert.equal(advanceIncident(first, history, context(3)).status, "recovered");
  body.certifiedHistoryRepair.through = "2026-08-15";
  const partial = await collectLight({ now: context().now, fetchImpl: async (url) => url.endsWith("/data/status")
    ? new Response(JSON.stringify(body)) : healthyResponse(url) });
  assert.equal(partial.find((row) => row.key === "certified-history").status, "failure");
});

test("public outage cannot invent historical failure, but independent admin sparse proof remains", async () => {
  for (const sparse of [false, true]) {
    const light = await collectLight({ now: context().now, fetchImpl: async (url) => {
      if (url.includes("api.vigieau.beta.gouv.fr")) return new Response(JSON.stringify({ status: "unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
      if (sparse && url.endsWith("/external-publications")) return new Response(JSON.stringify({ status: "stale", failedResourceCount: 0,
        historicExport: { status: "blocked", blocker: "sparse_statistic_cache", scheduledFor: "2026-09-07" } }));
      return healthyResponse(url);
    } });
    const history = combineObservations(light).find((row) => row.key === "certified-history");
    assert.equal(history.status, sparse ? "failure" : "pending");
  }
});

test("dry-run observes without any GitHub writes or token", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => { urls.push(url); return healthyResponse(url); });
  t.mock.method(console, "log", () => {});
  await main({ args: ["--dry-run"], env: {} });
  assert.equal(urls.length, 10);
  assert.equal(urls.some((url) => url.includes("api.github.com")), false);
});

test("failure diagnostics keep assertion but strip queries and raw payload", () => {
  assert.equal(safeFailureHint("AssertionError [ERR_ASSERTION]: https://api.example.test/health?token=secret returned 503: {\"password\":\"secret\"}"),
    "https://api.example.test/health returned 503");
});

test("rerun attempt does not constitute an independent recovery observation", () => {
  const opened = advanceIncident(null, failure, context(1));
  const first = advanceIncident(opened, success, context(2));
  assert.equal(advanceIncident(first, success, { ...context(2), observationId: "2:2" }), null);
});

test("old resource is not correlated to history without explicit sparse blocker evidence", () => {
  const deep = classifyDeep("datagouv", { code: 1, output: "Communes en restrictions is 75.0 hours old" });
  const history = observation("certified-history", "failure", "Historic canary failed");
  assert.deepEqual(combineObservations([history], [deep]).filter((row) => row.status === "failure").map((row) => row.key),
    ["certified-history", "deep-datagouv"]);
});

test("correlation cannot mutate away an incomplete source observation", () => {
  const unknown = observation("certified-history", "unknown", "Incomplete collection");
  const failed = observation("certified-history", "failure", "Explicit sparse blocker");
  const rows = combineObservations([unknown, failed]);
  assert.equal(rows[0].status, "failure");
  assert.equal(unknown.status, "unknown");
});

test("upstream failure suppresses duplicate dependent causes without claiming recovery", async () => {
  const rows = await collectLight({ fetchImpl: async (url) => {
    if (!url.includes("/api/")) return new Response("<html></html>", { headers: { "content-type": "text/html" } });
    return new Response(JSON.stringify({ status: "unavailable", usable: false }), { status: 503, headers: { "content-type": "application/json" } });
  } });
  assert.equal(rows.find((row) => row.key === "admin-api").status, "failure");
  assert.equal(rows.find((row) => row.key === "business-clock").status, "pending");
  assert.equal(rows.find((row) => row.key === "statistics-cache").status, "pending");
});

test("deep execution preserves scripts, strict policies and bounded timeouts", async () => {
  const seen = [];
  for (const name of ["statistics", "public", "browser", "admin", "sandre", "datagouv"]) {
    const result = await runDeep(name, { execute: (cmd, args, options, callback) => {
      seen.push(args[0]);
      assert.equal(options.timeout, 300_000);
      assert.equal(options.env.VIGIEAU_EXPECT_ZONE_PUBLICATION_MODE, "healthy");
      assert.equal(options.env.VIGIEAU_STATISTICS_DEADLINE, "06:00");
      callback(null, "", "");
    } });
    assert.equal(result.status, "success");
  }
  assert.equal(new Set(seen).size, 6);
  const timeout = await runDeep("browser", { execute: (_cmd, _args, _options, callback) => callback({ killed: true }, "", "") });
  assert.equal(timeout.status, "unknown");
});
