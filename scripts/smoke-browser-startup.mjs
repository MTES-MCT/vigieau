import { readFile } from "node:fs/promises";

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 1_000;

function parsePort(contents) {
  const firstLine = String(contents).trim().split("\n")[0];
  if (!/^\d+$/.test(firstLine)) return null;
  const port = Number(firstLine);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function childExitDescription(child) {
  if (child.exitCode !== null && child.exitCode !== undefined) {
    return `exit code ${child.exitCode}`;
  }
  if (child.signalCode !== null && child.signalCode !== undefined) {
    return `signal ${child.signalCode}`;
  }
  return null;
}

function childHasExited(child) {
  return childExitDescription(child) !== null;
}

async function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) return true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener?.("exit", onExit);
      child.removeListener?.("close", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(childHasExited(child)), timeoutMs);
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}

export async function terminateChild({
  child,
  graceMs = 2_000,
  killWaitMs = 2_000,
}) {
  if (childHasExited(child)) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, graceMs)) return;
  child.kill("SIGKILL");
  if (!(await waitForChildExit(child, killWaitMs))) {
    throw new Error("Chrome did not exit after SIGKILL");
  }
}

export async function waitForChromeDevTools({
  activePortPath,
  child,
  timeoutMs,
  readFileImpl = readFile,
  fetchImpl = fetch,
  now = Date.now,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  const deadline = now() + timeoutMs;
  let lastError = null;

  while (now() < deadline) {
    const exitDescription = childExitDescription(child);
    if (exitDescription) {
      throw new Error(
        `Chrome exited before DevTools was ready (${exitDescription})`,
      );
    }

    try {
      const port = parsePort(await readFileImpl(activePortPath, "utf8"));
      if (!port) {
        throw new Error("DevToolsActivePort does not contain a valid port");
      }
      const remainingMs = Math.max(1, deadline - now());
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(Math.min(requestTimeoutMs, remainingMs)),
      });
      if (!response.ok) {
        throw new Error(`Chrome DevTools returned HTTP ${response.status}`);
      }
      const targets = await response.json();
      const page = Array.isArray(targets)
        ? targets.find(
            (target) => target?.type === "page" && target.webSocketDebuggerUrl,
          )
        : null;
      if (!page) throw new Error("Chrome has no debuggable page target");
      return { port, webSocketDebuggerUrl: page.webSocketDebuggerUrl };
    } catch (error) {
      lastError = error;
    }

    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
  }

  const exitDescription = childExitDescription(child);
  if (exitDescription) {
    throw new Error(
      `Chrome exited before DevTools was ready (${exitDescription})`,
    );
  }
  throw new Error(
    `Chrome DevTools did not become ready within ${timeoutMs}ms${
      lastError ? `: ${lastError.message}` : ""
    }`,
  );
}
