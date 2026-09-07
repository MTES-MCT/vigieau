import { ref, type Ref, shallowRef } from 'vue';

export const useRetryableLoad = <T>(loader: () => Promise<T>, reportError?: (error: unknown) => void) => {
  const data = ref<T | null>(null) as Ref<T | null>;
  const error = shallowRef<unknown>(null);
  const loading = ref(false);

  const load = async () => {
    if (loading.value) {
      return;
    }
    loading.value = true;
    data.value = null;
    error.value = null;
    try {
      data.value = await loader();
    } catch (cause) {
      error.value = cause;
      reportError?.(cause);
    } finally {
      loading.value = false;
    }
  };

  return { data, error, loading, load };
};
