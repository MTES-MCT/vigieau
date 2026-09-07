import { CAUSES, INCIDENT_LABEL, MARKER, advanceIncident, incidentBody, parseIncident } from "./production-incidents-policy.mjs";

export class GitHubIncidents {
  constructor({ token, repository, fetchImpl = fetch, apiBase = "https://api.github.com", trustedAuthors }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository || "")) throw new Error("Invalid GitHub repository");
    if (!token) throw new Error("GITHUB_TOKEN is required outside --dry-run");
    this.token = token;
    this.root = `${apiBase}/repos/${repository}`;
    this.fetchImpl = fetchImpl;
    this.trustedAuthors = trustedAuthors;
  }

  async request(path, method = "GET", body) {
    const response = await this.fetchImpl(`${this.root}${path}`, {
      method,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path.split("?")[0]} returned ${response.status}`);
    return response.status === 204 ? null : response.json();
  }

  async list(path) {
    const result = [];
    for (let page = 1; ; page += 1) {
      const rows = await this.request(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new Error("Invalid GitHub list response");
      result.push(...rows);
      if (rows.length < 100) return result;
    }
  }

  async incidents() {
    const issues = await this.list(`/issues?state=all&labels=${INCIDENT_LABEL}`);
    const byKey = new Map();
    for (const issue of issues) {
      if (issue.pull_request) continue;
      const state = parseIncident(issue, this.trustedAuthors);
      if (!state) continue;
      if (byKey.has(state.key)) throw new Error(`Duplicate incident key: ${state.key}`);
      byKey.set(state.key, { issue, state });
    }
    return byKey;
  }

  async deliverPending(issue, state, { assignee, runUrl, now }) {
    const transition = state.pendingTransition;
    if (!transition) return state;
    const marker = `<!-- ${MARKER}:transition:${transition.id} -->`;
    const exists = async () => (await this.list(`/issues/${issue.number}/comments`))
      .some((comment) => (this.trustedAuthors || ["github-actions[bot]", "sghribi"]).includes(comment.user?.login) && comment.body?.includes(marker));
    if (!(await exists())) {
      const messages = { recovery: "RETABLI : deux observations completes reussies.",
        escalation: "AGGRAVATION : severite critique.", reminder: "RAPPEL QUOTIDIEN : incident toujours actif.",
        reopened: "NOUVEL EPISODE : la cause est de nouveau en echec." };
      try {
        await this.request(`/issues/${issue.number}/comments`, "POST", {
          body: `@${assignee} ${messages[transition.kind]}\n\n[Controle](${runUrl})\n\n${marker}`,
        });
      } catch (error) {
        // A timed-out POST may already have been accepted. Never retry it blindly.
        if (!(await exists())) throw error;
      }
    }
    const completed = { ...state, pendingTransition: null, lastNotificationAt: now.toISOString() };
    await this.request(`/issues/${issue.number}`, "PATCH", { body: incidentBody(completed, runUrl),
      state: completed.status === "open" ? "open" : "closed" });
    return completed;
  }

  async reconcile(observations, context) {
    if (!/^[a-zA-Z0-9-]+$/.test(context.assignee || "")) throw new Error("Invalid incident assignee");
    if (!(await this.list("/labels")).some((label) => label.name === INCIDENT_LABEL)) {
      try {
        await this.request("/labels", "POST", { name: INCIDENT_LABEL, color: "B60205", description: "Incidents de production suivis automatiquement" });
      } catch (error) {
        if (!(await this.list("/labels")).some((label) => label.name === INCIDENT_LABEL)) throw error;
      }
    }
    const incidents = await this.incidents();
    for (const item of observations) {
      let existing = incidents.get(item.key);
      if (existing?.state.pendingTransition) {
        existing.state = await this.deliverPending(existing.issue, existing.state, context);
      }
      const next = advanceIncident(existing?.state, item, context);
      if (!next) continue;
      if (!existing) {
        let issue;
        try {
          issue = await this.request("/issues", "POST", {
            title: `[PROD][${next.severity}] ${CAUSES[item.key][0]}`,
            body: `@${context.assignee} INCIDENT OUVERT.\n\n${incidentBody(next, context.runUrl)}`,
            labels: [INCIDENT_LABEL], assignees: [context.assignee],
          });
        } catch (error) {
          const reconciled = (await this.incidents()).get(item.key);
          if (!reconciled) throw error;
          issue = reconciled.issue;
        }
        incidents.set(item.key, { issue, state: next });
      } else {
        await this.request(`/issues/${existing.issue.number}`, "PATCH", {
          title: `[PROD][${next.severity}] ${CAUSES[item.key][0]}`,
          body: incidentBody(next, context.runUrl),
          // Recovery comment must be durable before the closing transition.
          state: next.pendingTransition?.kind === "recovery" ? "open" : next.status === "open" ? "open" : "closed",
        });
        await this.deliverPending(existing.issue, next, context);
      }
    }
  }

  async publishChecks(observations, { sha, runUrl, observationId }) {
    if (!/^[a-f0-9]{40}$/.test(sha || "")) throw new Error("A full GITHUB_SHA is required");
    for (const item of observations) {
      await this.request("/check-runs", "POST", {
        name: `Production / ${item.key}`, head_sha: sha, external_id: `${observationId}:${item.key}`,
        status: "completed", conclusion: item.status === "success" ? "success" : item.status === "pending" ? "neutral" : "failure",
        details_url: runUrl,
        output: { title: `${item.status.toUpperCase()} : ${CAUSES[item.key][0]}`,
          summary: `${item.detail}\n\nSeverite : ${item.severity}. Ce controle represente la sante de production, pas le succes du collecteur.` },
      });
    }
  }
}
