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
  const zoneAlerteMaxUpdatedAt: Ref<Moment | null> = ref(null);

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
  }

  function setZoneAlerteMaxUpdatedAt(value: string): void {
    zoneAlerteMaxUpdatedAt.value = value ? moment(value) : null;
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
    communes,
    setZoneAlerteMaxUpdatedAt,
    zoneAlerteMaxUpdatedAt,
  };
});
