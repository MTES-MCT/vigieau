import { useAlertStore } from "~/stores/alert";

export const useCustomFetch = (url: string, options: any) => {
  const alertStore = useAlertStore();
  
  return useFetch(url, options).then((res) => {
    const error = res.error.value;
    if(error) {
      alertStore.addAlert({
        description: error.data?.message,
        type: 'error',
      })   
    }
    return res;
  });
};
