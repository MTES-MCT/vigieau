<script setup lang="ts">
import type { Ref } from 'vue';
import { Parametres } from '~/dto/parametres.dto';
import { useAuthStore } from '~/stores/auth';

const api = useApi();
const parametres: Ref<Parametres[] | undefined> = ref();
const authStore = useAuthStore();
const parametresSelected: Ref<Parametres[] | undefined> = ref();

const loadParametres = async () => {
  const { data, error } = await api.parametres.list();
  if (data.value) {
    parametres.value = data.value;
    parametresSelected.value = findParametres();
  }
};

const findParametres = () => {
  return parametres.value;
  return parametres.value?.filter(p => authStore.user?.roleDepartements.includes(p.departement?.code));
};

const regleGestionSuperpositionCommuneFr = {
  no: 'Nous ne sommes pas concernés car une commune ne peut pas être concernée par plusieurs zones d\'alerte',
  no_all: 'Non, les restrictions s\'appliquent à la zone d\'alerte pour l\'ESU, l\'ESO et l\'AEP',
  yes_only_aep: 'Le niveau maximal s\'applique à la commune pour l’AEP mais les niveaux ESU et ESO s\'appliquent à la zone d\'alerte',
  yes_all: 'Un niveau unique; le plus restrictif parmi ESU, ESO et AEP; s\'applique à la commune pour toutes les ressources (1 niveau unique ESU-ESO-AEP)',
  yes_except_aep: 'Un niveau unique, le plus restrictif parmi ESU et ESO, s\'applique à la commune pour les milieux naturels (1 niveau unique ESU-ESO) et le niveau AEP est distinct',
  yes_distinct: 'Le niveau maximal s\'applique à la commune pour chaque type de ressource (1 niveau ESU, 1 niveau AEP, 1 niveau ESO)',
};

loadParametres();
</script>

<template>
  <p>Ce paramètre détermine le calcul des niveaux de restrictions affiché sur Vigieau pour chaque type de ressource (eaux souterraines, eaux
    superficielles, eau potable).</p>
  <div v-for="param in parametresSelected">
    <h3>Département {{ param.departement.code }}</h3>
    <p>Si une commune est concernée par plusieurs zones d’alerte, appliquez-vous le niveau de gravité maximal à l'échelle de la commune
      ?<br />
      <b>{{ regleGestionSuperpositionCommuneFr[param.superpositionCommune] }}</b></p>
  </div>
</template>