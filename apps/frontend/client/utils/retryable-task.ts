export interface RetryableTaskOptions {
  attempts: number;
  delayMs: number;
  signal: AbortSignal;
}

export interface LatestTaskRunner {
  cancel: () => void;
  run: <T>(
    task: (signal: AbortSignal) => Promise<T>,
    apply: (value: T) => void,
  ) => Promise<boolean>;
}

export interface RetryScheduler {
  clear: () => void;
  schedule: () => void;
}

interface RetrySchedulerOptions {
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export const createAbortError = (): Error => {
  const error = new Error('Operation aborted.');
  error.name = 'AbortError';
  return error;
};

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

export const createRetryScheduler = (
  task: () => void,
  delayMs: number,
  options: RetrySchedulerOptions = {},
): RetryScheduler => {
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const clear = (): void => {
    if (timeout !== null) {
      clearTimeoutFn(timeout);
      timeout = null;
    }
  };

  const schedule = (): void => {
    if (timeout !== null) {
      return;
    }
    timeout = setTimeoutFn(() => {
      timeout = null;
      task();
    }, delayMs);
  };

  return { clear, schedule };
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw createAbortError();
  }
};

const waitForRetry = (delayMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = (): void => {
      clearTimeout(timeout);
      reject(createAbortError());
    };
    signal.addEventListener('abort', abort, { once: true });
  });

export const runRetryableTask = async <T>(
  task: (signal: AbortSignal, attempt: number) => Promise<T>,
  options: RetryableTaskOptions,
): Promise<T> => {
  if (options.attempts < 1) {
    throw new Error('At least one attempt is required.');
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      return await task(options.signal, attempt);
    } catch (error) {
      if (options.signal.aborted || isAbortError(error)) {
        throw createAbortError();
      }
      lastError = error;
      if (attempt < options.attempts) {
        await waitForRetry(options.delayMs, options.signal);
      }
    }
  }

  throw lastError;
};

export const createLatestTaskRunner = (): LatestTaskRunner => {
  let generation = 0;
  let controller: AbortController | null = null;

  const cancel = (): void => {
    generation += 1;
    controller?.abort();
    controller = null;
  };

  const run = async <T>(
    task: (signal: AbortSignal) => Promise<T>,
    apply: (value: T) => void,
  ): Promise<boolean> => {
    cancel();
    const runGeneration = generation;
    const runController = new AbortController();
    controller = runController;

    try {
      const value = await task(runController.signal);
      if (
        runController.signal.aborted ||
        runGeneration !== generation ||
        controller !== runController
      ) {
        return false;
      }
      apply(value);
      return true;
    } finally {
      if (controller === runController) {
        controller = null;
      }
    }
  };

  return { cancel, run };
};
