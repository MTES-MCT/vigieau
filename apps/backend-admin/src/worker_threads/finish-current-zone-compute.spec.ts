import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { finishCurrentZoneComputeWorker } from './finish-current-zone-compute';
import { waitForCurrentZoneComputeWorker } from './run-current-zone-compute';

const workerModule = transpileModule(
  readFileSync(join(__dirname, 'finish-current-zone-compute.ts'), 'utf8'),
  {
    compilerOptions: {
      module: ModuleKind.CommonJS,
      target: ScriptTarget.ES2022,
    },
  },
).outputText;

describe('current zone compute worker finalization', () => {
  const workers: Worker[] = [];

  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.terminate();
  });

  function start(
    closeBody: string,
    options: {
      response?: object;
      closeTimeoutMs?: number;
      computationDelayMs?: number;
    } = {},
  ) {
    const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
    const state = new Int32Array(buffer);
    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const state = new Int32Array(workerData.buffer);
      const helper = { exports: {} };
      (function(exports) { ${workerModule} })(helper.exports);
      setInterval(() => {}, 1000);
      const logger = { log() {}, error() { Atomics.add(state, 2, 1); } };
      (async () => {
        await new Promise(resolve => setTimeout(resolve, workerData.computationDelayMs));
        await helper.exports.finishCurrentZoneComputeWorker(async () => {
          Atomics.add(state, 0, 1);
          ${closeBody}
          Atomics.store(state, 1, 1);
        }, workerData.response, logger, workerData.closeTimeoutMs);
      })();
    `,
      {
        eval: true,
        workerData: {
          buffer,
          response: options.response ?? {
            success: true,
            result: { departments: [81] },
          },
          closeTimeoutMs: options.closeTimeoutMs ?? 1000,
          computationDelayMs: options.computationDelayMs ?? 0,
        },
      },
    );
    workers.push(worker);
    const messages: unknown[] = [];
    worker.on('message', (message) => messages.push(message));
    return { worker, state, messages };
  }

  it('exits a real worker successfully despite a residual referenced interval', async () => {
    const { worker, state, messages } = start('');

    await expect(
      waitForCurrentZoneComputeWorker(worker, 5000),
    ).resolves.toEqual({
      success: true,
      result: { departments: [81] },
    });

    expect([...state]).toEqual([1, 1, 0]);
    expect(messages).toHaveLength(1);
  });

  it('does not send or acknowledge success before application cleanup completes', async () => {
    const { worker, state, messages } = start(
      "await new Promise(resolve => parentPort.once('message', resolve));",
    );
    let acknowledged = false;
    const completion = waitForCurrentZoneComputeWorker(worker, 5000).then(
      (result) => {
        acknowledged = true;
        return result;
      },
    );
    const deadline = Date.now() + 2000;
    while (Atomics.load(state, 0) === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(Atomics.load(state, 0)).toBe(1);
    expect(Atomics.load(state, 1)).toBe(0);
    expect(messages).toEqual([]);
    expect(acknowledged).toBe(false);

    worker.postMessage('complete cleanup');
    await expect(completion).resolves.toEqual(
      expect.objectContaining({ success: true }),
    );
    expect(Atomics.load(state, 1)).toBe(1);
    expect(messages).toHaveLength(1);
  });

  it('does not apply the close deadline to a still-running computation', async () => {
    const { worker } = start('', {
      computationDelayMs: 100,
      closeTimeoutMs: 20,
    });

    await expect(
      waitForCurrentZoneComputeWorker(worker, 5000),
    ).resolves.toEqual(expect.objectContaining({ success: true }));
  });

  it('keeps the skipped response after confirmed application cleanup', async () => {
    const { worker, state } = start('', {
      response: { success: true, skipped: true },
    });

    await expect(
      waitForCurrentZoneComputeWorker(worker, 5000),
    ).resolves.toEqual({ success: true, skipped: true });
    expect([...state]).toEqual([1, 1, 0]);
  });

  it.each([
    [
      'await new Promise(() => {});',
      'Compute map worker application close timed out',
    ],
    [
      "throw new Error('Application close failed');",
      'Application close failed',
    ],
  ])(
    'fails without acknowledgement when cleanup fails: %s',
    async (closeBody, error) => {
      const { worker, state, messages } = start(closeBody, {
        closeTimeoutMs: 30,
      });

      await expect(
        waitForCurrentZoneComputeWorker(worker, 5000),
      ).rejects.toThrow(`exit code 1: ${error}`);
      expect(messages).toEqual([{ success: false, error }]);
      expect([...state]).toEqual([1, 0, 1]);
    },
  );

  it.each([
    'await new Promise(() => {});',
    "throw new Error('Application close failed');",
  ])(
    'preserves the primary computation error when cleanup also fails: %s',
    async (closeBody) => {
      const response = {
        success: false,
        error: 'Computation or lock cleanup failed',
      };
      const { worker, messages } = start(closeBody, {
        response,
        closeTimeoutMs: 30,
      });

      await expect(
        waitForCurrentZoneComputeWorker(worker, 5000),
      ).rejects.toThrow(`exit code 1: ${response.error}`);
      expect(messages).toEqual([response]);
    },
  );

  it('keeps non-zero real worker exits fatal even after a success message', async () => {
    const worker = new Worker(
      "require('node:worker_threads').parentPort.postMessage({ success: true }); process.exit(2);",
      { eval: true },
    );
    workers.push(worker);

    await expect(waitForCurrentZoneComputeWorker(worker, 5000)).rejects.toThrow(
      'exit code 2',
    );
  });

  it('refuses to finalize or exit the main process', async () => {
    const closeApp = jest.fn();
    await expect(
      finishCurrentZoneComputeWorker(
        closeApp,
        { success: true },
        {
          log: jest.fn(),
          error: jest.fn(),
        },
      ),
    ).rejects.toThrow('requires a worker thread');
    expect(closeApp).not.toHaveBeenCalled();
  });
});
