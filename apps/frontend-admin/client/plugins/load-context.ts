import type { Departement } from '~/dto/departement.dto';
import type { Thematique } from '~/dto/thematique.dto';
import type { Usage } from '~/dto/usage.dto';
import { useAuthStore } from '~/stores/auth';
import { useRefDataStore } from '~/stores/refData';

export default defineNuxtPlugin((nuxtApp) => {
  const authStore = useAuthStore();
  const api = useApi();
  const globalLoaded = ref(false);

  // CHARGEMENT DES DONNEES DE REFERENCE QUAND L'UTILISATEUR EST CONNECTE
  const loadGlobal = async () => {
    if (!authStore.isAuthenticated) {
      globalLoaded.value = false;
      return;
    }
    if (globalLoaded.value) {
      return;
    }

    const [fecthDep, fetchUsage, fetchThematique, fetchZoneAlerteMaxUpdatedAt] = await Promise.all([
      api.departement.list(),
      api.usage.list(),
      api.thematique.list(),
      api.zoneAlerte.getMaxUpdatedAt(),
    ]);
    if (fecthDep.data.value) {
      useRefDataStore().setDepartements(<Departement[]>fecthDep.data.value);
    }
    if (fetchUsage.data.value) {
      useRefDataStore().setUsages(<Usage[]>fetchUsage.data.value);
    }
    if (fetchThematique.data.value) {
      useRefDataStore().setThematiques(<Thematique[]>fetchThematique.data.value);
    }
    if (fetchZoneAlerteMaxUpdatedAt.data.value) {
      useRefDataStore().setZoneAlerteMaxUpdatedAt(<string>fetchZoneAlerteMaxUpdatedAt.data.value);
    }
    globalLoaded.value = true;
  };
  watch(
    () => authStore.user,
    useUtils().debounce(async () => {
      await loadGlobal();
    }, 1),
    { immediate: true },
  );
});
