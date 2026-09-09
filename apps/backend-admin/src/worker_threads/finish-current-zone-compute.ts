import { isMainThread, parentPort } from 'node:worker_threads';
import type { ZoneComputeWorkerResult } from './run-current-zone-compute';

const APPLICATION_CLOSE_TIMEOUT_MS = 30_000;

export async function finishCurrentZoneComputeWorker(
  closeApp: () => Promise<void>,
  response: ZoneComputeWorkerResult & { skipped?: boolean },
  logger: {
    log(message: string): void;
    error(message: string, error: unknown): void;
  },
  closeTimeoutMs = APPLICATION_CLOSE_TIMEOUT_MS,
): Promise<never> {
  if (isMainThread || !parentPort) {
    throw new Error('Zone compute finalization requires a worker thread');
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let finalResponse = response;
  logger.log('Closing compute map worker application');
  try {
    await Promise.race([
      closeApp(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error('Compute map worker application close timed out')),
          closeTimeoutMs,
        );
      }),
    ]);
    logger.log('Compute map worker application closed');
  } catch (error) {
    logger.error('Error while closing compute map worker', error);
    if (response.success) {
      finalResponse = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    clearTimeout(timeout);
  }

  // Computation and lock cleanup have already settled. Exit only this thread,
  // even when unrelated handles keep its event loop alive after Nest closes.
  const exitCode = finalResponse.success ? 0 : 1;
  logger.log(
    `Compute map worker final response; exiting with code ${exitCode}`,
  );
  try {
    parentPort.postMessage(finalResponse);
  } catch (error) {
    logger.error('Unable to send compute map worker final response', error);
    process.exit(1);
  } finally {
    parentPort.close();
  }
  process.exit(exitCode);
}
