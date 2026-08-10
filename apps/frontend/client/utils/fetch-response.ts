import { ref } from 'vue';
import type { Ref } from 'vue';

export interface RefFetchResponse<T> {
  data: Ref<T | null>;
  error: Ref<unknown | null>;
}

export const fetchAsRefResponse = async <T>(
  request: () => Promise<T>,
): Promise<RefFetchResponse<T>> => {
  const data: Ref<T | null> = ref(null);
  const error: Ref<unknown | null> = ref(null);

  try {
    data.value = await request();
  } catch (requestError) {
    error.value = requestError;
  }

  return { data, error };
};
