<script setup lang="ts">
import niveauxGravite from '../../dto/niveauGravite';

const getLegendLabel = (niveauGravite: (typeof niveauxGravite)[number]) =>
  niveauGravite.niveauGravite === null
    ? 'Aucune restriction affichée'
    : niveauGravite.text;

const getLegendDescription = (
  niveauGravite: (typeof niveauxGravite)[number],
) =>
  niveauGravite.niveauGravite === null
    ? "L'absence de couleur ne confirme pas à elle seule l'absence de restriction. Sélectionnez un point pour vérifier les données disponibles."
    : niveauGravite.description;
</script>

<template>
  <div class="fr-grid-row">
    <template
      v-for="legend in niveauxGravite"
      :key="legend.niveauGravite ?? 'none'"
    >
      <DsfrTooltip on-hover :content="getLegendDescription(legend)">
        <DsfrBadge
          small
          @click="$event.preventDefault()"
          class="fr-mr-1w"
          :class="legend.class"
          type=""
          :label="getLegendLabel(legend)"
        />
      </DsfrTooltip>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.situation-level-bg-0 {
  color: var(--grey-0-1000);
}

:deep(.fr-link) {
  background: none;
}
</style>
