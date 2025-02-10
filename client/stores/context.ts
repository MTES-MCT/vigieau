import type { Ref } from 'vue';
import type { Thematique } from "~/dto/thematique.dto";

export const useContextStore = defineStore('contextStore', () => {
  const departementFilter: Ref<number | null | undefined> = ref();
  
  function setDepartementFilter(value: number | null | undefined): void {
    departementFilter.value = value;
  }
  
  function resetContext(): void {
    departementFilter.value = null;
  }

  return { departementFilter, setDepartementFilter, resetContext };
});
