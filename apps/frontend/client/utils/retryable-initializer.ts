export interface RetryableInitializer<T> {
  initialize: () => Promise<T | null>;
  value: () => T | null;
}

export const createRetryableInitializer = <T>(
  factory: () => T | null | Promise<T | null>,
): RetryableInitializer<T> => {
  let initializedValue: T | null = null;
  let initializationPromise: Promise<T | null> | null = null;

  const initialize = (): Promise<T | null> => {
    if (initializedValue) {
      return Promise.resolve(initializedValue);
    }
    if (initializationPromise) {
      return initializationPromise;
    }

    initializationPromise = Promise.resolve()
      .then(factory)
      .then((value) => {
        if (value) {
          initializedValue = value;
        }
        return value;
      })
      .finally(() => {
        initializationPromise = null;
      });

    return initializationPromise;
  };

  return {
    initialize,
    value: () => initializedValue,
  };
};
