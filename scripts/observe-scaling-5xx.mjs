import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";

const runFile = promisify(execFile);
const APP = "preservonsleau-api-prod";
const API = "https://api.vigieau.beta.gouv.fr";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEALTH_STATES = new Set(["ok", "ready", "degraded", "unavailable", "loading", "stale", "error"]);
const AVAILABILITY_STATES = new Set(["available", "unavailable", "confirmed_none"]);
const METRICS = new Set(["5XX", "p95_response_time", "memory", "cpu", "swap", "rpm", "rpm_per_container"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const boolean = (value) => typeof value === "boolean" ? value : null;
const uuid = (value) => typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
const state = (value, allowed) => allowed.has(value) ? value : null;

export function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!["--output-dir", "--until"].includes(name) || !args[index + 1] || options[name]) {
      throw new Error("Expected --output-dir ABSOLUTE_PATH --until UTC_ISO_DATE");
    }
    options[name] = args[index + 1];
  }
  const until = options["--until"];
  if (!isAbsolute(options["--output-dir"] || "") ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(until || "") ||
      !Number.isFinite(Date.parse(until)) ||
      new Date(until).toISOString() !== until.replace(/Z$/, until.includes(".") ? "Z" : ".000Z")) {
    throw new Error("Expected --output-dir ABSOLUTE_PATH --until UTC_ISO_DATE");
  }
  return { outputDir: options["--output-dir"], until: new Date(until).toISOString() };
}

function parseTimestamp(value) {
  const match = /^\w{3} (\w{3}) (\d{1,2}) (\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match || !MONTHS.includes(match[1])) return null;
  const [month, day, year, hour, minute, second] = match.slice(1);
  const date = new Date(Date.UTC(Number(year), MONTHS.indexOf(month), Number(day), Number(hour), Number(minute), Number(second)));
  if (date.getUTCMonth() !== MONTHS.indexOf(month) || date.getUTCDate() !== Number(day) ||
      date.getUTCHours() !== Number(hour) || date.getUTCMinutes() !== Number(minute) || date.getUTCSeconds() !== Number(second)) return null;
  return date.toISOString();
}

export function parseTimeline(text) {
  const lines = stripVTControlCharacters(text).split("\n");
  const events = [];
  let ignoredAlertCount = 0;
  let entryCount = 0;
  for (const line of lines) {
    if (!/^\*\s/.test(line)) continue;
    entryCount += 1;
    if (!/ - Alert\s+- /.test(line)) continue;
    const match = /^\*\s+(.+?)\s+- Alert\s+- High (5xx Errors|Response Time|Memory|CPU|Swap|RPM) usage on container [a-zA-Z0-9_-]+ (triggered|resolved) \(value: ([\d.]+)\s*,/.exec(line);
    const timestamp = match ? parseTimestamp(match[1].trim()) : null;
    if (!match || !timestamp || !Number.isFinite(Number(match[4]))) {
      ignoredAlertCount += 1;
      continue;
    }
    const metric = { "5xx Errors": "5XX", "Response Time": "p95_response_time", Memory: "memory", CPU: "cpu", Swap: "swap", RPM: "rpm" }[match[2]];
    events.push({ timestamp, type: match[3], metric, value: Number(match[4]) });
  }
  if (!entryCount && !/no events|no activity/i.test(text)) throw new Error("invalid_cli_output");
  return { events, entryCount, ignoredAlertCount, potentiallyTruncated: entryCount >= 30 };
}

function durationMs(value) {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(value);
  if (!match || !match.slice(1).some(Boolean)) return null;
  return integer((Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000);
}

export function parseAlerts(text) {
  const lines = stripVTControlCharacters(text).split("\n");
  if (!lines.some((line) => /ACTIVE/.test(line) && /METRIC/.test(line))) throw new Error("invalid_cli_output");
  const alerts = [];
  for (const line of lines) {
    const cells = line.split("│").slice(1, -1).map((cell) => cell.trim());
    if (!/^al-[a-f0-9-]+$/i.test(cells[0] || "")) continue;
    const [, active, container, metric, limit, reminder] = cells;
    const match = /^(≥|≤|>|<)\s+([\d.]+)\s+\(for ([\dhms.]+)\)$/.exec(limit || "");
    if (!["true", "false"].includes(active) || !["web", "statcache"].includes(container) ||
        !METRICS.has(metric) || !match || !Number.isFinite(Number(match[2])) ||
        durationMs(match[3]) === null || durationMs(reminder) === null) throw new Error("invalid_cli_output");
    alerts.push({ active: active === "true", container, metric,
      comparison: { "≥": "gte", "≤": "lte", ">": "gt", "<": "lt" }[match[1]],
      limit: Number(match[2]), durationMs: durationMs(match[3]), reminderMs: durationMs(reminder) });
  }
  return alerts;
}

export function summarizeHealth(body) {
  if (!body || typeof body !== "object" || !HEALTH_STATES.has(body.status)) throw new Error("invalid_response");
  return {
    status: state(body.status, HEALTH_STATES), usable: boolean(body.usable), fresh: boolean(body.fresh),
    publicationId: uuid(body.publication?.activeId) || uuid(body.artifactPublicationId),
    liveInstances: integer(body.publication?.instances?.live ?? body.artifactLiveInstances),
    readyInstances: integer(body.publication?.instances?.activeReady ?? body.artifactReadyInstances),
  };
}

export function summarizeZones(body) {
  if (!Array.isArray(body?.zones) || !body.availability ||
      ["SUP", "SOU", "AEP"].some((type) => !AVAILABILITY_STATES.has(body.availability[type]?.status)) ||
      body.zones.some((zone) => !["SUP", "SOU", "AEP"].includes(zone?.type) || (zone.id !== null && integer(zone.id) === null))) {
    throw new Error("invalid_response");
  }
  return {
    zoneCount: body.zones.length,
    zoneIds: body.zones.map((zone) => integer(zone.id)).filter((id) => id !== null).sort((a, b) => a - b),
    counts: Object.fromEntries(["SUP", "SOU", "AEP"].map((type) => [type, body.zones.filter((zone) => zone.type === type).length])),
    availability: Object.fromEntries(["SUP", "SOU", "AEP"].map((type) => [type, state(body.availability[type]?.status, AVAILABILITY_STATES)])),
  };
}

async function readJson(response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 1_048_576) throw new Error("response_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function collectObservation(until, { fetchImpl = globalThis.fetch, execFileImpl = runFile, now = Date.now } = {}) {
  const deadline = Date.parse(until);
  if (!Number.isFinite(deadline)) throw new Error("Invalid deadline");
  const capturedAt = new Date(now()).toISOString();
  const base = { schemaVersion: 1, app: APP, capturedAt, until: new Date(deadline).toISOString() };
  if (now() >= deadline) return { ...base, status: "expired" };
  const remaining = (maximum) => Math.max(0, Math.min(maximum, deadline - now()));

  async function inspect(path, summarize) {
    const started = performance.now();
    const timeoutMs = remaining(15_000);
    if (!timeoutMs) return { httpStatus: null, error: "deadline" };
    let httpStatus = null;
    try {
      const response = await fetchImpl(`${API}${path}`, {
        method: "GET", redirect: "error", headers: { Accept: "application/json", "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      httpStatus = response.status;
      const body = await readJson(response);
      if (httpStatus !== 200) return { httpStatus, durationMs: Math.round(performance.now() - started) };
      return { httpStatus, durationMs: Math.round(performance.now() - started), ...summarize(body) };
    } catch (error) {
      const reason = error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout"
        : httpStatus === null ? "network" : "invalid_response";
      return { httpStatus, durationMs: Math.round(performance.now() - started), error: reason };
    }
  }

  async function scalingo(command, args, parse) {
    const timeout = remaining(20_000);
    if (!timeout) return { error: "deadline" };
    try {
      const { stdout } = await execFileImpl("scalingo", ["--app", APP, command, ...args], {
        encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 512 * 1024,
        env: { ...process.env, TZ: "UTC", NO_COLOR: "1" },
      });
      try { return { data: parse(stdout) }; } catch { return { error: "invalid_cli_output" }; }
    } catch (error) {
      return { error: error?.killed || error?.code === "ETIMEDOUT" ? "timeout" : "command_failed" };
    }
  }

  const [live, ready, cache, statistics, timeline, alerts] = await Promise.all([
    ...["live", "ready", "cache", "statistics"].map((name) => inspect(`/api/health/${name}`, summarizeHealth)),
    scalingo("timeline", ["--per-page", "30"], parseTimeline),
    scalingo("alerts", [], parseAlerts),
  ]);
  const publicationId = cache.publicationId || ready.publicationId || null;
  const query = new URLSearchParams({ lon: "3.16", lat: "43.6154", commune: "34028" });
  if (publicationId) query.set("publicationId", publicationId);
  const zones = { ...await inspect(`/api/zones/v2?${query}`, summarizeZones), publicationId, publicationPinned: publicationId !== null };
  const health = { live, ready, cache, statistics };
  const http = [...Object.values(health), zones];
  const incomplete = http.some((item) => item.error) || timeline.error || alerts.error || timeline.data?.ignoredAlertCount > 0;
  const degraded = http.some((item) => (item.httpStatus !== null && item.httpStatus !== 200) || item.usable === false || item.fresh === false) ||
    (zones.httpStatus === 200 && !zones.error && ["SUP", "SOU"].some((type) => zones.counts[type] < 1 || zones.availability[type] !== "available"));
  return { ...base, completedAt: new Date(now()).toISOString(), status: incomplete ? "incomplete" : "complete",
    state: degraded ? "degraded" : incomplete ? "unknown" : "healthy", health, zones, timeline, alerts };
}

export function renderSummary(observation) {
  const lines = [`${APP} — ${observation.capturedAt}`, `Collecte : ${observation.status}`, `Fin prévue : ${observation.until}`];
  if (observation.status === "expired") return `${lines.join("\n")}\nAucune lecture réseau après expiration.\n`;
  lines.push(`État observé : ${observation.state}`);
  for (const [name, value] of Object.entries(observation.health)) {
    lines.push(`${name} : HTTP ${value.httpStatus ?? "inconnu"}, usable=${value.usable ?? "inconnu"}, fresh=${value.fresh ?? "inconnu"}${value.error ? `, collecte=${value.error}` : ""}`);
  }
  lines.push(`Cas Hérault V2 : HTTP ${observation.zones.httpStatus ?? "inconnu"}, zones=${observation.zones.zoneCount ?? "inconnu"}, publication=${observation.zones.publicationId ?? "inconnue"}`);
  lines.push(`Timeline : ${observation.timeline.error || `${observation.timeline.data.events.length} événements d'alerte lus (30 entrées maximum)`}`);
  lines.push(`Configuration alertes : ${observation.alerts.error || `${observation.alerts.data.length} règles lues`}`);
  lines.push("Observation ponctuelle ; ne démontre pas une disponibilité continue ni l'absence de tout 5xx entre deux lectures.");
  return `${lines.join("\n")}\n`;
}

export async function writeObservation(outputDir, observation) {
  if (!isAbsolute(outputDir)) throw new Error("Output directory must be absolute");
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  async function atomic(name, content) {
    const temporary = join(outputDir, `.${name}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
      await rename(temporary, join(outputDir, name));
    } finally { await rm(temporary, { force: true }); }
  }
  const json = `${JSON.stringify(observation, null, 2)}\n`;
  await atomic(`${observation.capturedAt.replace(/:/g, "-")}.json`, json);
  await atomic("latest.json", json);
  await atomic("latest.txt", renderSummary(observation));
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const { outputDir, until } = parseArgs(args);
  const observation = await collectObservation(until, dependencies);
  await writeObservation(outputDir, observation);
  console.log(JSON.stringify({ status: observation.status, state: observation.state, capturedAt: observation.capturedAt, until }));
  return observation.status === "incomplete" ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(); }
  catch { console.error("Observation failed: check arguments, CLI availability and output directory access."); process.exitCode = 1; }
}
