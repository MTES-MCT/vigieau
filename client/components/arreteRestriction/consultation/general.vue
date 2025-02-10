<script setup lang="ts">
import type { ArreteRestriction } from "~/dto/arrete_restriction.dto";

const props = defineProps<{
  arreteRestriction: ArreteRestriction;
}>();

const utils = useUtils();

const ressourcesConcernes = computed(() => {
  if(props.arreteRestriction.restrictions.filter((r) => !r.isAep).length < 1) {
    return 'Eau potable';
  } else if (props.arreteRestriction.restrictions.filter((r) => r.isAep).length < 1 && !props.arreteRestriction.ressourceEapCommunique) {
    return 'Eaux superficielles et/ou souterraines';
  } else {
    return 'Eaux superficielles, eaux souterraines et eau potable';
  }
})

const ressourceEapCommunique = computed(() => {
  switch (props.arreteRestriction.ressourceEapCommunique) {
    case 'esu':
      return 'ESU';
    case 'eso':
      return 'ESO';
    case 'max':
      return 'Niveau maximal';
  }
})
</script>

<template>
  <h2>Généralité</h2>
  <p>Date de mise en vigueur&nbsp;: {{ utils.formatDate(arreteRestriction.dateDebut) }}</p>
  <p>Date de fin&nbsp;: {{ utils.formatDate(arreteRestriction.dateFin) }}</p>
  <p>Date de signature&nbsp;: {{ utils.formatDate(arreteRestriction.dateSignature) }}</p>
  <p>Arrêtés cadre associés :</p>
  <DsfrHighlight>
    <span v-for="ac of arreteRestriction.arretesCadre">{{ ac.numero }}<br/></span>
  </DsfrHighlight>
  <DsfrFileDownload
    v-if="arreteRestriction.fichier"
    format="PDF"
    :href="arreteRestriction.fichier.url"
    :size="utils.fileSizeString(arreteRestriction.fichier.size)"
    :download="arreteRestriction.fichier.url"
    :title="arreteRestriction.fichier.nom"
  />
  <div v-if="arreteRestriction.fichier" class="fr-mb-2w"></div>
  <p>Ressources concernées par les restrictions&nbsp;: {{ ressourcesConcernes }}</p>
  <p v-if="arreteRestriction.ressourceEapCommunique">Niveau de gravité qui s'applique à l'eau potable&nbsp;: {{ ressourceEapCommunique }}</p>
</template>