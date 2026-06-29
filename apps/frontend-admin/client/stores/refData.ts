import type { Moment } from 'moment';
import moment from 'moment';
import type { Ref } from 'vue';
import type { Commune } from '~/dto/commune.dto';
import type { Departement } from '~/dto/departement.dto';
import type { Thematique } from '~/dto/thematique.dto';
import type { Usage } from '~/dto/usage.dto';
import type { ZoneAlerte } from '~/dto/zone_alerte.dto';

export const useRefDataStore = defineStore('refDataStore', () => {
  const departements: Ref<Departement[]> = ref([]);
  const usages: Ref<Usage[]> = ref([]);
  const zonesAlerte: Ref<ZoneAlerte[]> = ref([]);
  const thematiques: Ref<Thematique[]> = ref([]);
  const communes: Ref<Commune[]> = ref([]);
  const communesLoading: Ref<boolean> = ref(false);
  const communesLoaded: Ref<boolean> = ref(false);
  const communesDepCodesLoaded: Ref<string[]> = ref([]);
  const zoneAlerteMaxUpdatedAt: Ref<Moment | null> = ref(null);
  const communesFetches = new Map<string, Promise<void>>();

  function setDepartements(value: Departement[]): void {
    departements.value = value;
    zonesAlerte.value = departements.value.map((d) => d.zonesAlerte).flat();
  }

  function setUsages(value: Usage[]): void {
    usages.value = value;
  }

  function setThematiques(value: Thematique[]): void {
    thematiques.value = value;
  }

  function setCommunes(value: Commune[]): void {
    communes.value = value;
    communesLoaded.value = true;
  }

  function setZoneAlerteMaxUpdatedAt(value: string): void {
    zoneAlerteMaxUpdatedAt.value = value ? moment(value) : null;
  }

  function mergeCommunes(value: Commune[]): void {
    const communesByCode = new Map(communes.value.map((commune) => [commune.code, commune]));
    value.forEach((commune) => communesByCode.set(commune.code, commune));
    communes.value = Array.from(communesByCode.values()).sort((a, b) => a.code.localeCompare(b.code));
  }

  async function ensureCommunesLoaded(depCodes?: string[]): Promise<void> {
    const normalizedDepCodes = [...new Set(depCodes?.filter(Boolean) || [])].sort();
    if (communesLoaded.value) {
      return;
    }
    if (
      normalizedDepCodes.length > 0 &&
      normalizedDepCodes.every((depCode) => communesDepCodesLoaded.value.includes(depCode))
    ) {
      return;
    }

    const key = normalizedDepCodes.length > 0 ? normalizedDepCodes.join(',') : 'all';
    if (communesFetches.has(key)) {
      return communesFetches.get(key);
    }

    communesLoading.value = true;
    const promise = (async () => {
      const api = useApi();
      const query = normalizedDepCodes.length > 0 ? `depCode=${normalizedDepCodes.join(',')}` : undefined;
      const { data, error } = await api.commune.list(query);
      if (error.value || !data.value) {
        return;
      }

      if (normalizedDepCodes.length > 0) {
        mergeCommunes(<Commune[]>data.value);
        communesDepCodesLoaded.value = [
          ...new Set([...communesDepCodesLoaded.value, ...normalizedDepCodes]),
        ].sort();
      } else {
        setCommunes(<Commune[]>data.value);
      }
    })().finally(() => {
      communesFetches.delete(key);
      communesLoading.value = communesFetches.size > 0;
    });

    communesFetches.set(key, promise);
    return promise;
  }

  return {
    setDepartements,
    departements,
    zonesAlerte,
    setUsages,
    usages,
    setThematiques,
    thematiques,
    setCommunes,
    ensureCommunesLoaded,
    communes,
    communesLoading,
    communesLoaded,
    setZoneAlerteMaxUpdatedAt,
    zoneAlerteMaxUpdatedAt,
  };
});
