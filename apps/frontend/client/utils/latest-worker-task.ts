interface TaskWorker {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage: (value: unknown) => void;
  terminate: () => void;
}

export function createLatestWorkerTask(
  createWorker: () => TaskWorker,
  onResult: (result: any) => void,
  onError: (error: unknown) => void,
) {
  let current: TaskWorker | null = null;
  let disposed = false;

  const cancel = () => {
    if (current) {
      current.onmessage = null;
      current.onerror = null;
      current.terminate();
      current = null;
    }
  };

  return {
    run(value: unknown) {
      if (disposed) {
        return;
      }
      cancel();
      try {
        const worker = createWorker();
        current = worker;
        worker.onmessage = (event) => {
          if (current !== worker || disposed) {
            return;
          }
          cancel();
          try {
            onResult(event.data);
          } catch (error) {
            onError(error);
          }
        };
        worker.onerror = (event) => {
          if (current !== worker || disposed) {
            return;
          }
          event.preventDefault();
          cancel();
          onError(event.error || new Error(event.message));
        };
        worker.postMessage(value);
      } catch (error) {
        cancel();
        onError(error);
      }
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}
