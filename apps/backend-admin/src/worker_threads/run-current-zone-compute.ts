import { Worker } from 'worker_threads';
import { workerThreadFilePath } from './config';

export interface ZoneComputeWorkerResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

const CURRENT_ZONE_COMPUTE_TIMEOUT_MS = 60 * 60 * 1000;

export function waitForCurrentZoneComputeWorker(
  worker: Worker,
  timeoutMs = CURRENT_ZONE_COMPUTE_TIMEOUT_MS,
): Promise<ZoneComputeWorkerResult> {
  return new Promise((resolve, reject) => {
    let result: ZoneComputeWorkerResult | undefined;
    let settled = false;
    const timeout = setTimeout(async () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        await worker.terminate();
        reject(new Error('Zone compute worker timed out'));
      } catch (error) {
        reject(
          new Error(
            `Unable to terminate timed out zone compute worker: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    }, timeoutMs);

    worker.once('message', (message: ZoneComputeWorkerResult) => {
      result = message;
    });
    worker.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    worker.once('exit', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Zone compute worker stopped with exit code ${code}`));
        return;
      }
      if (!result) {
        reject(new Error('Zone compute worker exited without a result'));
        return;
      }
      resolve(result);
    });
  });
}

export function runCurrentZoneComputeWorker(
  depsIds: number[],
): Promise<ZoneComputeWorkerResult> {
  return waitForCurrentZoneComputeWorker(
    new Worker(workerThreadFilePath, {
      workerData: {
        depsIds,
        computeHistoric: false,
      },
    }),
  );
}
