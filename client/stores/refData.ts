import type { Ref } from 'vue';
import type { Departement } from '~/dto/departement.dto';
import type { ZoneAlerte } from '~/dto/zone_alerte.dto';
import type { Usage } from '~/dto/usage.dto';
import type { Thematique } from '~/dto/thematique.dto';

export const useRefDataStore = defineStore('refDataStore', () => {
  const departements: Ref<Departement[]> = ref([]);
  const usages: Ref<Usage[]> = ref([]);
  const zonesAlerte: Ref<ZoneAlerte[]> = ref([]);
  const thematiques: Ref<Thematique[]> = ref([]);

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

  return { setDepartements, departements, zonesAlerte, setUsages, usages, setThematiques, thematiques };
});
