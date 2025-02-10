<script setup lang="ts">
import { RestrictionNiveauGraviteFr } from "~/dto/restriction.dto";

const props = defineProps<{
  niveauGravite: string;
}>();

const restrictionNiveauGraviteFr = RestrictionNiveauGraviteFr;
</script>

<template>
  <DsfrBadge :label="restrictionNiveauGraviteFr[niveauGravite]" :type="niveauGravite" />
</template>