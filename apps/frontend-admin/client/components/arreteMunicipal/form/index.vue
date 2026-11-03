<script setup lang="ts">
import type { Ref } from 'vue';
import { ArreteMunicipal } from '~/dto/arrete_municipal.dto';
import { useAuthStore } from '~/stores/auth';

const arreteMunicipal: Ref<ArreteMunicipal | undefined> = ref();

const api = useApi();
const route = useRoute();
const authStore = useAuthStore();
const isNewArreteMunicipal = route.params.id === 'nouveau';

if (isNewArreteMunicipal) {
  arreteMunicipal.value = new ArreteMunicipal(authStore.user);
} else {
  const { data, error: _error } = await api.arreteMunicipal.get(route.params.id as string);
  if (data.value) {
    arreteMunicipal.value = JSON.parse(JSON.stringify(data.value)) as ArreteMunicipal;
  }
}
</script>

<template>
  <h1>
    {{ isNewArreteMunicipal ? 'Création' : 'Edition' }} d'un arrêté municipal
    <MixinsStatutBadge :statut="arreteMunicipal?.statut" />
  </h1>
  <b
    >L’arrêté municipal sera publié sur Vigieau.<br />
    Il doit être au moins aussi restrictif que l’arrêté préfectoral.</b
  >
  <ArreteMunicipalFormWrapper v-if="arreteMunicipal" :arreteMunicipal="arreteMunicipal" />
</template>
