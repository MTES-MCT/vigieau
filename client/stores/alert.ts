import type { Ref } from "vue";
import type { AlertDto } from "~/dto/alert.dto";

export const useAlertStore = defineStore('alertStore', () => {
  const alerts: Ref<AlertDto[]> = ref([]);

  function addAlert(alert: AlertDto) {
    alert.id = Math.floor(Math.random() * 1000000);
    alerts.value.push(alert);
    setTimeout(() => {
      clearAlert(alert.id);
    }, 10000);
  }
  
  function clearAlert(id: number | undefined): void {
    const index = alerts.value.findIndex((alert) => alert.id === id); // find alert
    alerts.value.splice(index, 1); // remove alert from array
  }
  
  function clearAll(): void {
    alerts.value = [];
  }

  return { alerts, addAlert, clearAlert, clearAll };
})
