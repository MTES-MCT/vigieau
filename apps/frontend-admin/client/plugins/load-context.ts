import {useAuthStore} from "~/stores/auth";
import {useRefDataStore} from "~/stores/refData";
import type {Departement} from "~/dto/departement.dto";
import type {Usage} from "~/dto/usage.dto";
import type {Thematique} from "~/dto/thematique.dto";
import type {Commune} from "~/dto/commune.dto";

export default defineNuxtPlugin((nuxtApp) => {
  const authStore = useAuthStore();
  const api = useApi();

  // CHARGEMENT DES DONNEES DE REFERENCE QUAND L'UTILISATEUR EST CONNECTE
  const loadGlobal = async () => {
    if (await authStore.isAuthenticated) {
      const [
        fecthDep,
        fetchUsage,
        fetchThematique,
        fetchCommune,
        fetchZoneAlerteMaxUpdatedAt,
      ] = await Promise.all(
        [
          api.departement.list(),
          api.usage.list(),
          api.thematique.list(),
          api.commune.list(),
          api.zoneAlerte.getMaxUpdatedAt(),
        ]
      );
      if (fecthDep.data.value) {
        useRefDataStore().setDepartements(<Departement[]>fecthDep.data.value);
      }
      if (fetchUsage.data.value) {
        useRefDataStore().setUsages(<Usage[]>fetchUsage.data.value);
      }
      if (fetchThematique.data.value) {
        useRefDataStore().setThematiques(<Thematique[]>fetchThematique.data.value);
      }
      if (fetchCommune.data.value) {
        useRefDataStore().setCommunes(<Commune[]>fetchCommune.data.value);
      }
      if (fetchZoneAlerteMaxUpdatedAt.data.value) {
        useRefDataStore().setZoneAlerteMaxUpdatedAt(<string>fetchZoneAlerteMaxUpdatedAt.data.value);
      }
    }
  }
  watch(
    () => authStore.isAuthenticated,
    useUtils().debounce(async () => {
      loadGlobal();
    }, 1)
  );
});