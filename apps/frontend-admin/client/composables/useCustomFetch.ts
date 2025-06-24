import { useAlertStore } from '~/stores/alert';

export const useCustomFetch = (url: string, options: any, timeout: number = 10000) => {
  const alertStore = useAlertStore();

  const customOptions = {
    ...options,
    timeout,
  };

  return useFetch(url, customOptions).then((res) => {
    const error = res.error.value;
    if (error) {
      alertStore.addAlert({
        description: error.data?.message,
        type: 'error',
      });
    }
    return res;
  });
};
