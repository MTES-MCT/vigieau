import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { GATEWAY_VERSION, gatewayConfiguration, profile } from "./config.mjs";

// Each child has its own process group, including shell/Nginx descendants.
export function superviseProcesses(commands, { graceMs = 8000 } = {}) {
  return new Promise((resolveExit) => {
    let stopping = false;
    let result = 1;
    let timer;
    let forced = false;
    const children = [];
    const running = new Set();
    const killGroup = (child, signal) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const finish = () => {
      if (!stopping || running.size) return;
      if (
        !forced &&
        children.some((child) => {
          if (!child.pid) return false;
          try {
            process.kill(-child.pid, 0);
            return true;
          } catch {
            return false;
          }
        })
      )
        return;
      clearTimeout(timer);
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      resolveExit(result);
    };
    const stop = (code) => {
      if (stopping) return;
      stopping = true;
      result = code;
      for (const child of children) killGroup(child, "SIGTERM");
      timer = setTimeout(() => {
        for (const child of children) killGroup(child, "SIGKILL");
        forced = true;
        finish();
      }, graceMs);
      finish();
    };
    const onTerm = () => stop(0);
    const onInt = () => stop(0);
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    for (const { command, args = [], env = process.env } of commands) {
      const child = spawn(command, args, {
        env,
        detached: true,
        stdio: "inherit",
      });
      children.push(child);
      running.add(child);
      child.once("error", () => {
        running.delete(child);
        stop(1);
        finish();
      });
      child.once("exit", (code) => {
        running.delete(child);
        stop(code || 1);
        finish();
      });
    }
    if (!commands.length) stop(1);
  });
}

async function main() {
  const directory = dirname(fileURLToPath(import.meta.url));
  const role = readFileSync(join(directory, "role"), "utf8").trim();
  const settings = profile(process.env, role);
  const build = JSON.parse(readFileSync(join(directory, "build.json"), "utf8"));
  if (build.enabled !== settings.enabled || build.version !== GATEWAY_VERSION)
    throw new Error("Authentication mode changed: rebuild the application");
  const normal =
    role === "frontend"
      ? { command: "/app/bin/run" }
      : { command: "npm", args: ["run", "start:prod"] };
  if (settings.enabled) gatewayConfiguration(process.env, role);
  const commands = [
    {
      ...normal,
      env: { ...process.env, ...(settings.enabled ? { PORT: "8080" } : {}) },
    },
  ];
  if (settings.enabled)
    commands.push({
      command: process.execPath,
      args: [join(directory, "gateway.mjs"), role],
      env: process.env,
    });
  process.exitCode = await superviseProcesses(commands);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      `Preproduction authentication configuration rejected: ${error.message}`,
    );
    process.exitCode = 1;
  });
}
