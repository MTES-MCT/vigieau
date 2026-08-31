const publicApiBase = (
  process.env.VIGIEAU_API_URL || "https://api.vigieau.beta.gouv.fr"
).replace(/\/+$/, "");
const adminApiBase = (
  process.env.VIGIEAU_ADMIN_API_URL || "https://api.admin.vigieau.beta.gouv.fr"
).replace(/\/+$/, "");
const timeoutMs = Number(process.env.VIGIEAU_SMOKE_TIMEOUT_MS || 15_000);

const endpoints = {
  publicLive: `${publicApiBase}/api/health/live`,
  publicReady: `${publicApiBase}/api/health/ready`,
  publicCache: `${publicApiBase}/api/health/cache`,
  statistics: `${publicApiBase}/api/health/statistics`,
  dataStatus: `${publicApiBase}/api/data/status`,
  adminLive: `${adminApiBase}/api/health/live`,
  adminReady: `${adminApiBase}/api/health/ready`,
  zonePublication: `${adminApiBase}/api/health/zone-publication`,
  sandreReferences: `${adminApiBase}/api/health/sandre-references`,
  sandreSynchronization: `${adminApiBase}/api/health/sandre-synchronization`,
  externalPublications: `${adminApiBase}/api/health/external-publications`,
  mapArchives: `${adminApiBase}/api/health/map-archives`,
  clock: `${adminApiBase}/api/health/clock`,
};

async function inspect(url) {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${url}?diagnostic=${Date.now()}`, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text.slice(0, 2_000);
    }
    return {
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
      body,
    };
  } catch (error) {
    return {
      httpStatus: null,
      durationMs: Date.now() - startedAt,
      requestFailure: {
        name: String(error?.name || "Error"),
        message: String(error?.message || error),
      },
    };
  }
}
const entries = await Promise.all(
  Object.entries(endpoints).map(async ([name, url]) => [name, await inspect(url)]),
);
const diagnostic = {
  capturedAt: new Date().toISOString(),
  endpoints: Object.fromEntries(entries),
};

const json = JSON.stringify(diagnostic, null, 2);
console.log(json);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## Production health diagnostic\n\nCaptured at ${diagnostic.capturedAt}.\n\n\`\`\`json\n${json}\n\`\`\`\n`,
  );
}
