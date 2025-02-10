<script setup lang="ts">
import type { ArreteCadre } from "~/dto/arrete_cadre.dto";

const props = defineProps<{
  arreteCadre: ArreteCadre;
}>();

const utils = useUtils();
</script>

<template>
  <h2>Généralité</h2>
  <p>Cet arrêté est {{ arreteCadre.departements.length > 1 ? 'interdépartemental' : 'départemental'}}</p>
  <DsfrHighlight>
    <span v-for="d of arreteCadre.departements">{{ d.nom }}<br/></span>
  </DsfrHighlight>
  <p>Date d'entrée en vigueur&nbsp;: {{ utils.formatDate(arreteCadre.dateDebut) }}</p>
  <p>Date de fin&nbsp;: {{ utils.formatDate(arreteCadre.dateFin) }}</p>
  <DsfrFileDownload
    v-if="arreteCadre.fichier"
    format="PDF"
    :href="arreteCadre.fichier.url"
    :size="utils.fileSizeString(arreteCadre.fichier.size)"
    :download="arreteCadre.fichier.url"
    :title="arreteCadre.fichier.nom"
  />
  <div v-if="arreteCadre.fichier" class="fr-mb-2w"></div>
</template>