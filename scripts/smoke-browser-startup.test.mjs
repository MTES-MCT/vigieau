import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  terminateChild,
  waitForChromeDevTools,
} from "./smoke-browser-startup.mjs";

function harness({ reads = [], responses = [], child = {} } = {}) {
  let time = 0;
  let readIndex = 0;
  let responseIndex = 0;
  return {
    options: {
      activePortPath: "/tmp/DevToolsActivePort",
      child: { exitCode: null, signalCode: null, ...child },
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      now: () => time,
      sleep: async (delay) => {
        time += delay;
      },
      readFileImpl: async () => {
        const value = reads[Math.min(readIndex, reads.length - 1)];
        readIndex += 1;
        if (value instanceof Error) throw value;
        return value;
      },
      fetchImpl: async () => {
        const value = responses[Math.min(responseIndex, responses.length - 1)];
        responseIndex += 1;
        if (value instanceof Error) throw value;
        return {
          ok: value?.status === undefined || value.status === 200,
          status: value?.status ?? 200,
          json: async () => value?.targets ?? [],
        };
      },
    },
    counts: () => ({ reads: readIndex, responses: responseIndex, time }),
  };
}

const pageTarget = {
  type: "page",
  webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/1",
};

test("waits for a late DevToolsActivePort file", async () => {
  const state = harness({
    reads: [new Error("ENOENT"), new Error("ENOENT"), "9222\n"],
    responses: [{ targets: [pageTarget] }],
  });
  const result = await waitForChromeDevTools(state.options);
  assert.equal(result.port, 9222);
  assert.ok(state.counts().reads >= 3);
});

test("retries a refused DevTools endpoint", async () => {
  const state = harness({
    reads: ["9222\n"],
    responses: [new Error("ECONNREFUSED"), { targets: [pageTarget] }],
  });
  const result = await waitForChromeDevTools(state.options);
  assert.equal(result.webSocketDebuggerUrl, pageTarget.webSocketDebuggerUrl);
  assert.equal(state.counts().responses, 2);
});

test("retries an empty or malformed port", async () => {
  const state = harness({
    reads: ["", "not-a-port", "70000", "9333\n"],
    responses: [{ targets: [pageTarget] }],
  });
  const result = await waitForChromeDevTools(state.options);
  assert.equal(result.port, 9333);
});

test("waits until a page target exists", async () => {
  const state = harness({
    reads: ["9222\n"],
    responses: [{ targets: [] }, { targets: [pageTarget] }],
  });
  await waitForChromeDevTools(state.options);
  assert.equal(state.counts().responses, 2);
});

test("fails immediately when Chrome exits", async () => {
  const state = harness({ child: { exitCode: 1 } });
  await assert.rejects(waitForChromeDevTools(state.options), /exit code 1/);
  assert.equal(state.counts().time, 0);
});

test("fails immediately when Chrome is killed by a signal", async () => {
  const state = harness({ child: { signalCode: "SIGKILL" } });
  await assert.rejects(waitForChromeDevTools(state.options), /signal SIGKILL/);
  assert.equal(state.counts().time, 0);
});

test("reports the last bootstrap error at the deadline", async () => {
  const state = harness({ reads: ["invalid"] });
  state.options.timeoutMs = 250;
  await assert.rejects(
    waitForChromeDevTools(state.options),
    /within 250ms: DevToolsActivePort does not contain a valid port/,
  );
});

test("escalates to SIGKILL and waits when Chrome ignores SIGTERM", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") {
      child.signalCode = signal;
      queueMicrotask(() => child.emit("exit", null, signal));
    }
    return true;
  };

  await terminateChild({ child, graceMs: 1, killWaitMs: 50 });

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.signalCode, "SIGKILL");
});
