import { useAlertStore } from '~/stores/alert';
import { getApiErrorMessage } from '~/composables/useApiErrorHandler';

export const useCustomFetch = (url: string, options: any, timeout: number = 10000, showAlert = true) => {
  const alertStore = useAlertStore();

  const customOptions = {
    ...options,
    timeout,
  };

  return useFetch(url, customOptions).then((res) => {
    const error = res.error.value;
    if (error && showAlert) {
      alertStore.addAlert({
        description: getApiErrorMessage(error),
        type: 'error',
      });
    }
    return res;
  });
};
