<script setup lang="ts">
import moment from 'moment';
import { json2csv } from 'json-2-csv';
import { sortByDateDesc } from '../../utils/date-sort';

const props = defineProps<{
  dataArea: any,
  typeEau: any,
  territoire: string,
  dateDebut: string,
  dateFin: string,
}>();

const headers = ['Date', 'Vigilance', 'Alerte', 'Alerte renforcée', 'Crise'];
const rows = ref([]);

async function downloadCsv() {
  const formatData = sortByDateDesc(props.dataArea)
    .map((stat: any) => {
      return {
        date: stat.date,
        vigilance: stat[props.typeEau].vigilance,
        alerte: stat[props.typeEau].alerte,
        alerte_renforcee: stat[props.typeEau].alerte_renforcee,
        crise: stat[props.typeEau].crise,
      };
    });
  const csv = await json2csv(formatData, {
    expandArrayObjects: true,
  });

  // Create a CSV file and allow the user to download it
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `tableau_surface_${props.territoire}_${props.dateDebut}_${props.dateFin}_${props.typeEau}.csv`;
  a.click();
}

watch(() => [props.typeEau, props.dataArea], () => {
  if (!props.dataArea) {
    return;
  }
  rows.value = sortByDateDesc(props.dataArea).map(s => {
    return [
      moment(s.date).format('DD/MM/YYYY'),
      s[props.typeEau].vigilance + '%',
      s[props.typeEau].alerte + '%',
      s[props.typeEau].alerte_renforcee + '%',
      s[props.typeEau].crise + '%',
    ];
  });
}, { immediate: true });
</script>

<template>
  <AccessibleDataTable
    table-id="area-restrictions-history-table"
    title="Évolution journalière du pourcentage de la surface concernée par des niveaux de gravité"
    :headers="headers"
    :rows="rows"
    table-class="fr-table--sm"
    fixed-layout
  />

  <div class="text-align-right fr-mt-1w">
    <DsfrButton @click="downloadCsv()">
      Télécharger les données (CSV)
    </DsfrButton>
  </div>
</template>
