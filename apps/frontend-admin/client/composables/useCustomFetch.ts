import { $fetch } from 'ofetch';
import { ref } from 'vue';
import { useAlertStore } from '~/stores/alert';
import { getApiErrorMessage } from '~/composables/useApiErrorHandler';

export const useCustomFetch = async (url: string, options: any, timeout: number = 10000, showErrorAlert = true) => {
  const alertStore = useAlertStore();
  const data = ref<any>(null);
  const error = ref<any>(null);

  const customOptions = {
    ...options,
    timeout,
  };

  // API actions must run on every call, independently of Nuxt's async-data cache.
  try {
    data.value = await $fetch(url, customOptions);
  } catch (requestError) {
    error.value = requestError;
    if (showErrorAlert) {
      alertStore.addAlert({
        description: getApiErrorMessage(requestError),
        type: 'error',
      });
    }
  }
  return { data, error };
};
