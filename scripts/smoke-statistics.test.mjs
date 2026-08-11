import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { getStatisticFreshnessPolicy } from "./smoke-statistics-policy.mjs";

function dateRange(from, to) {
  const dates = [];
  const current = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

async function runSmoke({ now, latestDate, expectedExitCode = 0 }) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const send = (body, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (url.pathname === "/api/health/live") {
      return send({ status: "ok" });
    }
    if (url.pathname === "/api/health/statistics") {
      return send({
        status: "ready",
        usable: true,
        fresh: true,
        mode: "legacy-bootstrap",
        currentPublishedDate: latestDate,
        firstDate: "2013-01-01",
        latestDate,
        dateCount: 4_964,
        departmentCount: 101,
        communeCount: 34_943,
        fingerprint: "a".repeat(64),
        loadedAt: now,
        lastError: null,
      });
    }

    const requestedStart = url.searchParams.get("dateDebut");
    if (url.pathname === "/api/data/departement") {
      return send(
        dateRange(requestedStart, latestDate).map((date) => ({
          date,
          departements: Array.from({ length: 101 }, (_, index) => ({
            code: String(index),
          })),
        })),
      );
    }
    if (url.pathname === "/api/data/area") {
      return send(
        dateRange(requestedStart, latestDate).map((date) => ({
          date,
          ESU: {},
          ESO: {},
          AEP: {},
        })),
      );
    }
    if (url.pathname === "/api/data/commune/65440") {
      return send({
        commune: { code: "65440" },
        restrictions: dateRange(`${requestedStart}-01`, latestDate).map(
          (date) => ({ date }),
        ),
      });
    }
    return send({ statusCode: 404 }, 404);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const child = spawn(process.execPath, ["scripts/smoke-statistics.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VIGIEAU_API_URL: `http://127.0.0.1:${server.address().port}`,
        VIGIEAU_STATISTICS_NOW: now,
        VIGIEAU_STATISTICS_DEADLINE: "06:00",
        VIGIEAU_STATISTICS_MAXIMUM_LAG_DAYS: "",
        VIGIEAU_STATISTICS_SAMPLE_COUNT: "2",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const exitCode = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(exitCode, expectedExitCode, stderr || stdout);
    if (expectedExitCode !== 0) {
      return { stdout, stderr };
    }
    return JSON.parse(stdout.trim().split("\n").at(-1));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("accepts yesterday before the Paris daily deadline", async () => {
  const result = await runSmoke({
    now: "2026-08-11T03:30:00.000Z",
    latestDate: "2026-08-10",
  });
  assert.equal(result.afterDeadline, false);
  assert.equal(result.maximumLagDays, 1);
  assert.equal(result.latestDate, "2026-08-10");
});

test("requires today after the Paris daily deadline", async () => {
  const result = await runSmoke({
    now: "2026-08-11T04:30:00.000Z",
    latestDate: "2026-08-11",
  });
  assert.equal(result.afterDeadline, true);
  assert.equal(result.maximumLagDays, 0);
  assert.equal(result.latestDate, "2026-08-11");
});

test("rejects yesterday after the Paris daily deadline", async () => {
  const result = await runSmoke({
    now: "2026-08-11T04:30:00.000Z",
    latestDate: "2026-08-10",
    expectedExitCode: 1,
  });
  assert.match(
    result.stderr,
    /Statistics stop at 2026-08-10 \(1 days behind 2026-08-11\)/,
  );
});

test("keeps an explicit lag override after the deadline", () => {
  const policy = getStatisticFreshnessPolicy({
    now: new Date("2026-08-11T04:30:00.000Z"),
    deadline: "06:00",
    maximumLagDays: 2,
  });
  assert.equal(policy.afterDeadline, true);
  assert.equal(policy.maximumLagDays, 2);
});
