export const INCIDENT_LABEL = "production-incident";
export const MARKER = "vigieau-production-incident:v1";
export const CAUSES = {
  "public-front": ["Site public indisponible", "critical"],
  "admin-front": ["Administration indisponible", "critical"],
  "public-api": ["API publique indisponible", "critical"],
  "admin-api": ["API administration indisponible", "critical"],
  "public-cache": ["Cache public degrade", "warning"],
  "statistics-cache": ["Cache statistique degrade", "warning"],
  "business-clock": ["Horloge metier arretee", "critical"],
  "zone-publication": ["Publication des zones en retard", "warning"],
  "external-publications": ["Publications externes en retard", "warning"],
  "certified-history": ["Historique certifie et exports incoherents", "warning"],
  "deep-statistics": ["Coherence des statistiques", "warning"],
  "deep-public": ["Parcours public", "critical"],
  "deep-browser": ["Carte et parcours navigateur", "critical"],
  "deep-admin": ["Controles metier administration", "warning"],
  "deep-sandre": ["References et synchronisation SANDRE", "warning"],
  "deep-datagouv": ["Publications data.gouv.fr", "warning"],
};

export function observation(key, status, detail, extra = {}) {
  if (!Object.hasOwn(CAUSES, key)) throw new Error("Unknown incident cause");
  if (!["success", "failure", "unknown", "pending"].includes(status)) {
    throw new Error("Invalid observation status");
  }
  return { key, status, detail, severity: CAUSES[key][1], ...extra };
}

export function classifyDeep(name, result) {
  if (!Object.hasOwn(CAUSES, `deep-${name}`)) throw new Error("Unknown deep check");
  if (result.unknown) {
    return observation(`deep-${name}`, "unknown", "Execution du controle incomplete");
  }
  if (result.code === 0) return observation(`deep-${name}`, "success", "Contrat verifie");
  const history = ["statistics", "datagouv", "admin", "public"].includes(name) &&
    /certified history|public history|public statistics no longer start|ZIP member maximum inspected date|sparse_statistic_cache|historicStatistics is not healthy|healthy historic status incomplete|historicClean is not healthy|historicCursors is not healthy/i.test(result.output || "");
  const hint = safeFailureHint(result.output);
  return observation(history ? "certified-history" : `deep-${name}`, "failure",
    hint || (history ? "Le contrat historique certifie ou ses exports est invalide" : "Le smoke strict a echoue"),
    { source: name, publicationAgeFailure: name === "datagouv" && /(?:Communes|Historique Communes).*hours old/.test(result.output || "") });
}

export function safeFailureHint(output = "") {
  const line = output.match(/(?:AssertionError(?: \[ERR_ASSERTION\])?|TypeError|Error): ([^\n]+)/)?.[1] || "";
  return line.replace(/https?:\/\/[^\s)]+/g, (url) => {
    try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; } catch { return "[url]"; }
  }).replace(/\s*[:=]?\s*[\[{].*$/, "").replace(/\b(?:Bearer|token|password|api[_-]?key)\s*[:=]?\s*\S+/gi, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 300);
}

export function hasCoveringCertifiedRepair(body, now = new Date()) {
  const repair = body.certifiedHistoryRepair;
  const civilDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  return Boolean(repair && [body.historicDirtyFrom, body.historicDirtyThrough, repair.from, repair.through].every(civilDate) &&
    repair.from <= body.historicDirtyFrom && repair.through >= body.historicDirtyThrough &&
    body.historicDirtyFrom <= body.historicDirtyThrough &&
    [repair.id, repair.sourceRunId, repair.publicationRevision].every((value) => typeof value === "string" && value.length > 0) &&
    Number.isFinite(Date.parse(repair.activatedAt)) && Date.parse(repair.activatedAt) <= now.getTime());
}

export function combineObservations(light, deep = []) {
  const results = [];
  const sparseHistory = light.some((item) => item.key === "certified-history" && item.historyBlocker === "sparse_statistic_cache" && item.status === "failure");
  for (const original of [...light, ...deep]) {
    const item = sparseHistory && original.publicationAgeFailure
      ? { ...original, key: "certified-history" } : original;
    const previous = results.find((row) => row.key === item.key);
    if (!previous) results.push({ ...item });
    else if (item.status === "failure") {
      const detail = [...new Set([previous.detail, item.detail])].join(" | ").slice(0, 900);
      Object.assign(previous, item, { detail });
    }
  }
  // Only both complete contracts can prove recovery of the shared history cause.
  if (deep.length && !results.some((row) => row.key === "certified-history")) {
    const historical = ["deep-statistics", "deep-datagouv"].map((key) => deep.find((row) => row.key === key));
    results.push(observation("certified-history", historical.every((row) => row?.status === "success")
      ? "success" : "pending", "Retablissement exige statistiques et exports verifies"));
  }
  return results;
}

export function parseIncident(issue, trustedAuthors = ["github-actions[bot]", "sghribi"]) {
  if (!issue.body?.includes(MARKER)) return null;
  if (!trustedAuthors.includes(issue.user?.login)) throw new Error(`Untrusted incident author: #${issue.number}`);
  const match = issue.body.match(/<!-- vigieau-production-incident:v1\n([^\n]+)\n-->/);
  if (!match) throw new Error(`Invalid incident metadata: #${issue.number}`);
  const state = JSON.parse(match[1]);
  if (state.version !== 1 || !Object.hasOwn(CAUSES, state.key) ||
      !["open", "recovered"].includes(state.status) ||
      !["warning", "critical"].includes(state.severity) ||
      !Number.isInteger(state.recoveryCount) || state.recoveryCount < 0 ||
      ![state.firstSeenAt, state.lastSeenAt, state.lastNotificationAt].every((value) => typeof value === "string" && Number.isFinite(Date.parse(value))) ||
      typeof state.lastObservationId !== "string" ||
      (state.latestDetail !== undefined && (typeof state.latestDetail !== "string" || state.latestDetail.length > 500)) ||
      (state.pendingTransition && (!/^[a-zA-Z0-9:._-]+$/.test(state.pendingTransition.id) ||
        !["recovery", "escalation", "reminder", "reopened"].includes(state.pendingTransition.kind)))) {
    throw new Error(`Invalid incident state: #${issue.number}`);
  }
  return state;
}

export function advanceIncident(previous, item, { now, observationId, remind = true }) {
  if (previous?.lastObservationId === observationId) return null;
  if (previous?.lastObservationId.split(":")[0] === observationId.split(":")[0] && item.status === "success") return null;
  if (["unknown", "pending"].includes(item.status)) {
    return previous?.status === "open" && previous.recoveryCount > 0
      ? { ...previous, recoveryCount: 0, lastObservationId: observationId } : null;
  }
  if (!previous && item.status === "success") return null;
  const stamp = now.toISOString();
  const latestDetail = String(item.detail || "").replace(/[\r\n]/g, " ").slice(0, 500);
  if (!previous) return {
    version: 1, key: item.key, status: "open", severity: item.severity,
    firstSeenAt: stamp, lastSeenAt: stamp, lastNotificationAt: stamp,
    lastObservationId: observationId, recoveryCount: 0, pendingTransition: null, latestDetail,
  };
  const next = { ...previous, lastSeenAt: stamp, lastObservationId: observationId, latestDetail };
  let kind;
  if (item.status === "failure") {
    next.recoveryCount = 0;
    if (previous.status === "recovered") {
      next.status = "open";
      next.firstSeenAt = stamp;
      next.severity = item.severity;
      kind = "reopened";
    } else if (previous.severity === "warning" && item.severity === "critical") {
      next.severity = "critical";
      kind = "escalation";
    } else if (remind && now.getTime() - Date.parse(previous.lastNotificationAt) >= 86_400_000) kind = "reminder";
  } else if (previous.status === "open") {
    next.recoveryCount += 1;
    if (next.recoveryCount >= 2) {
      next.status = "recovered";
      kind = "recovery";
    }
  }
  if (kind) next.pendingTransition = { id: `${item.key}:${observationId}:${kind}`, kind };
  return next;
}

export function incidentBody(state, runUrl) {
  const title = CAUSES[state.key][0];
  const detail = (state.latestDetail || "Diagnostic detaille dans les checks").replace(/[\\`*_[\]<>#]/g, "\\$&");
  const history = state.key === "certified-history";
  const runbook = history ? "certified-history-recovery-20260907.md" : "production-monitoring.md";
  return `## ${title}\n\n` +
    `Etat : **${state.status === "open" ? "INCIDENT OUVERT" : "RETABLI"}**. Severite : **${state.severity}**.\n\n` +
    `Impact : ${history ? "historique certifie ou export incomplet ; les services courants sont controles separement" : "le contrat de production indique ci-dessous n'est plus garanti"}.\n\n` +
    `Dernier diagnostic : ${detail}\n\n` +
    `Action : consulter le [guide de diagnostic et de retablissement](https://github.com/MTES-MCT/vigieau/blob/master/docs/${runbook}).\n\n` +
    `Premiere observation : ${state.firstSeenAt}. Derniere observation : ${state.lastSeenAt}.\n\n` +
    `Cause : \`${state.key}\`. Retablissement : deux controles complets consecutifs reussis.\n\n` +
    `[Derniere collecte et controles detailles](${runUrl})\n\n` +
    `Une fermeture manuelle ne constitue pas une preuve de retablissement.\n\n` +
    `<!-- ${MARKER}\n${JSON.stringify(state)}\n-->`;
}
