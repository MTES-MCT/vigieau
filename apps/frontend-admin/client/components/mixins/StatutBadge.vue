<script setup lang="ts">
import type { Ref } from "vue";
import { ArreteCadreStatutFr } from "~/dto/arrete_cadre.dto";

const props = defineProps<{
  statut: string;
}>();

const frBadgeClass: Ref<string> = ref('');
const arreteCadreStatutFr = ArreteCadreStatutFr;

switch (props.statut) {
  case 'a_valider':
    frBadgeClass.value = 'fr-badge--info';
    break;
  case 'a_venir':
    frBadgeClass.value = 'fr-badge--new';
    break;
  case 'publie':
    frBadgeClass.value = 'fr-badge--success';
    break;
  case 'abroge':
    frBadgeClass.value = '';
    break;
}
</script>

<template>
  <DsfrBadge :label="arreteCadreStatutFr[statut]" :class="frBadgeClass" :type="null" :no-icon="true" />
</template>