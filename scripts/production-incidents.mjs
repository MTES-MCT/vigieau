import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { smokeFetch } from "./smoke-http.mjs";
import { CAUSES, classifyDeep, combineObservations, hasCoveringCertifiedRepair, observation } from "./production-incidents-policy.mjs";
import { GitHubIncidents } from "./production-incidents-github.mjs";
import { getStatisticFreshnessPolicy } from "./smoke-statistics-policy.mjs";
import { classifyExternalPublicationConvergence } from "./wait-external-publications-policy.mjs";
import { classifyZonePublicationConvergence } from "./wait-zone-publication-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const DEEP_NAMES = ["statistics", "public", "browser", "admin", "sandre", "datagouv"];

export async function collectLight({ env = process.env, fetchImpl = fetch, now = new Date() } = {}) {
  const publicApi = (env.VIGIEAU_API_URL || "https://api.vigieau.beta.gouv.fr").replace(/\/+$/, "");
  const adminApi = (env.VIGIEAU_ADMIN_API_URL || "https://api.admin.vigieau.beta.gouv.fr").replace(/\/+$/, "");
  const specs = [
    ["public-front", env.VIGIEAU_FRONT_URL || "https://vigieau.gouv.fr/", "html"],
    ["admin-front", env.VIGIEAU_ADMIN_FRONT_URL || "https://admin.vigieau.beta.gouv.fr/", "html"],
    ["public-api", `${publicApi}/api/health/live`, "ok"],
    ["admin-api", `${adminApi}/api/health/ready`, "ready"],
    ["public-cache", `${publicApi}/api/health/cache`, "ready"],
    ["statistics-cache", `${publicApi}/api/health/statistics`, "ready"],
    ["business-clock", `${adminApi}/api/health/clock`, "healthy"],
    ["zone-publication", `${adminApi}/api/health/zone-publication`, "healthy"],
    ["certified-history", `${publicApi}/api/data/status`, "historic"],
    ["external-publications", `${adminApi}/api/health/external-publications`, "external"],
  ];
  const results = [];
  for (const [key, url, expected] of specs) {
    try {
      const response = await smokeFetch(url, { headers: { Accept: expected === "html" ? "text/html" : "application/json", "Cache-Control": "no-cache" } },
        { timeoutMs: 15_000, fetchImpl });
      if (expected === "html") {
        const valid = response.ok && /text\/html/i.test(response.headers.get("content-type") || "");
        await response.body?.cancel();
        results.push(observation(key, valid ? "success" : "failure", `HTTP ${response.status}, contrat HTML ${valid ? "valide" : "invalide"}`));
        continue;
      }
      const text = await response.text();
      let body;
      try { body = JSON.parse(text); } catch {
        results.push(observation(key, "failure", `HTTP ${response.status}, reponse JSON invalide`,
          expected === "historic" ? { dependsOn: "public-api" } : {}));
        continue;
      }
      if (expected === "historic") {
        if (!response.ok || typeof body?.historicComplete !== "boolean") {
          results.push(observation(key, "failure", "Le contrat de completude historique est indisponible", { dependsOn: "public-api" }));
        } else if ((!body.historicComplete || body.historicDirtyFrom || body.historicDirtyThrough) && !hasCoveringCertifiedRepair(body, now)) {
          const rangeKnown = [body.historicDirtyFrom, body.historicDirtyThrough].every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value || "")) &&
            body.historicDirtyThrough >= body.historicDirtyFrom;
          const days = rangeKnown ? Math.round((Date.parse(body.historicDirtyThrough) - Date.parse(body.historicDirtyFrom)) / 86_400_000) + 1 : null;
          results.push(observation(key, "failure", rangeKnown && Number.isFinite(days)
            ? `Historique non certifie du ${body.historicDirtyFrom} au ${body.historicDirtyThrough} : ${days} dates civiles`
            : "L'historique public est incomplet ou contient une plage non certifiee", { dependsOn: "public-api" }));
        }
        // A clean health response cannot substitute for the two deep historical canaries.
        continue;
      }
      if (expected === "external") {
        const decision = classifyExternalPublicationConvergence(body);
        if (body.historicExport.blocker === "sparse_statistic_cache") {
          results.push(observation("certified-history", "failure", "Exports bloques par sparse_statistic_cache", { historyBlocker: "sparse_statistic_cache" }));
          results.push(observation(key, Number(body.failedResourceCount) > 0 ? "failure" : "pending",
            Number(body.failedResourceCount) > 0 ? "Des ressources externes sont en echec independamment du blocage historique"
              : "Publication bloquee par la cause historique, aucun retablissement deduit"));
        } else {
          const afterGrace = getStatisticFreshnessPolicy({ now, deadline: "07:00" }).expectedPublishedDate >= body.historicExport.scheduledFor;
          const updatingExpired = decision.state === "updating" && (decision.reason === "network_retry"
            ? Number(body.networkRetry?.failureAgeSeconds) > 3600 : afterGrace);
          results.push(observation(key, response.ok && decision.state === "stable" ? "success"
            : decision.state === "updating" && !updatingExpired ? "pending" : "failure",
          `Publication externe : ${decision.state}, ${String(decision.reason || "contrat valide").replace(/[^a-zA-Z0-9_ -]/g, "").slice(0, 80)}`));
        }
        continue;
      }
      if (key === "zone-publication") {
        const decision = classifyZonePublicationConvergence(body);
        const gracePolicy = getStatisticFreshnessPolicy({ now, deadline: "07:00" });
        const businessDateValid = /^\d{4}-\d{2}-\d{2}$/.test(body.businessDate || "") &&
          body.businessDate >= gracePolicy.expectedPublishedDate && body.businessDate <= gracePolicy.today;
        const status = !response.ok || !businessDateValid || decision.state === "blocked" ? "failure"
          : decision.state === "updating" ? "pending" : "success";
        results.push(observation(key, status, !businessDateValid
          ? "Date metier de publication depassee apres le delai de grace de 07:00 Paris, ou invalide"
          : status === "pending" ? "Publication servie et en progression recente, aucun retablissement deduit"
            : status === "success" ? "Contrat de publication courante valide" : "Publication non servie ou sans progression recente"));
        continue;
      }
      let valid = response.ok && body?.status === expected;
      if (["public-cache", "statistics-cache"].includes(key)) valid &&= body?.usable === true && body?.fresh === true;
      if (key === "statistics-cache") {
        const policy = getStatisticFreshnessPolicy({ now });
        valid &&= body.currentFresh === true && body.publicationDeadline === policy.deadline &&
          body.expectedPublishedDate === policy.expectedPublishedDate && body.currentPublishedDate >= policy.expectedPublishedDate;
      }
      const unusable = ["public-cache", "statistics-cache"].includes(key) && body?.usable === false;
      results.push(observation(key, valid ? "success" : "failure", `HTTP ${response.status}, contrat de sante ${valid ? "valide" : "invalide"}`,
        unusable ? { severity: "critical" } : {}));
    } catch (error) {
      const collectorBug = /invalid|unsupported|must be|unavailable|empty/i.test(String(error?.message || ""));
      results.push(observation(key, collectorBug ? "unknown" : "failure",
        collectorBug ? "Configuration ou collecte invalide" : "Requete externe en echec apres tentatives bornees",
        expected === "historic" ? { dependsOn: "public-api" } : {}));
    }
  }
  // Unavailable upstream APIs must not generate extra causes for every dependent endpoint.
  for (const [parent, children] of [["public-api", ["public-cache", "statistics-cache"]],
    ["admin-api", ["business-clock", "zone-publication", "external-publications"]]]) {
    if (results.find((item) => item.key === parent)?.status === "failure") {
      for (const item of results.filter((row) => children.includes(row.key) || row.dependsOn === parent)) {
        item.status = "pending";
        item.detail = `Non concluant : dependance ${parent} indisponible`;
      }
    }
  }
  return results;
}

export function runDeep(name, { env = process.env, execute = execFile } = {}) {
  if (!DEEP_NAMES.includes(name)) throw new Error("Unknown deep smoke");
  return new Promise((done) => {
    execute(process.execPath, [`scripts/smoke-${name}.mjs`], {
      cwd: root, timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...env, VIGIEAU_STATISTICS_DEADLINE: "06:00", VIGIEAU_STATISTICS_MINIMUM_INSTANCE_COUNT: "3",
        VIGIEAU_EXPECT_STATISTIC_ARTIFACT: "true", VIGIEAU_MIN_ZONE_COUNT: "1",
        VIGIEAU_EXPECT_ZONE_PUBLICATION_MODE: "healthy", VIGIEAU_ZONE_PUBLICATION_DEADLINE: "06:00",
        VIGIEAU_LEGACY_ARTIFACT_MAX_SKEW_MINUTES: "30", VIGIEAU_BROWSER_SMOKE_TIMEOUT_MS: "90000",
        VIGIEAU_BROWSER_TARBES_MODE: "adaptive", VIGIEAU_EXPECT_SANDRE_MODES: "safe", VIGIEAU_EXPECT_MAP_ARCHIVES: "disabled" },
    }, (error, stdout, stderr) => {
      const output = `${stdout || ""}\n${stderr || ""}`;
      done(classifyDeep(name, { code: error ? error.code : 0, output,
        unknown: Boolean(error?.killed || error?.code === "ENOENT" ||
          /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|SyntaxError:/.test(output)) }));
    });
  });
}

export async function main({ args = process.argv.slice(2), env = process.env } = {}) {
  const dryRun = args.includes("--dry-run");
  const deep = args.includes("--deep") || env.VIGIEAU_MONITOR_DEEP === "true";
  if (args.some((arg) => !["--dry-run", "--deep"].includes(arg))) throw new Error("Unknown collector option");
  const now = new Date();
  const light = await collectLight({ env });
  // All six contracts run even when another one fails. Each process has a five-minute deadline.
  const deepResults = deep ? await Promise.all(DEEP_NAMES.map((name) => runDeep(name, { env }))) : [];
  const observations = combineObservations(light, deepResults);
  const summary = `## Sante de production\n\nCollecte ${now.toISOString()} (${deep ? "complete" : "legere"}).\n\n` +
    `| Cause | Resultat | Severite |\n| --- | --- | --- |\n` +
    observations.map((item) => `| ${CAUSES[item.key][0]} | ${item.status.toUpperCase()} | ${item.severity} |`).join("\n") +
    "\n\nLe succes du collecteur ne signifie pas que la production est saine. Les checks Production et les issues font foi.\n";
  console.log(JSON.stringify({ dryRun, deep, capturedAt: now.toISOString(), observations }, null, 2));
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, summary);
  if (!dryRun) {
    if (env.GITHUB_EVENT_NAME !== "schedule" && env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
      throw new Error("Writes are restricted to scheduled or manually dispatched collector runs");
    }
    if (env.GITHUB_REF !== "refs/heads/master") throw new Error("Incident writes require master");
    const context = { now, observationId: `${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT || "1"}`,
      assignee: env.VIGIEAU_INCIDENT_ASSIGNEE || "sghribi", sha: env.GITHUB_SHA,
      runUrl: `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
      remind: env.VIGIEAU_INCIDENT_DAILY_REMINDER !== "false" };
    if (!/^\d+:\d+$/.test(context.observationId)) throw new Error("Invalid workflow run identity");
    const github = new GitHubIncidents({ token: env.GITHUB_TOKEN, repository: env.GITHUB_REPOSITORY });
    await github.publishChecks(observations, context);
    await github.reconcile(observations, context);
  }
  if ([...light, ...deepResults].some((item) => item.status === "unknown")) throw new Error("Collection incomplete: no recovery inferred for unknown observations");
  return observations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Incident collector failed: ${error.message}`); process.exitCode = 1; });
}
