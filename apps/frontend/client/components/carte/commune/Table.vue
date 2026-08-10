<script setup lang="ts">
import { json2csv } from 'json-2-csv';

const props = defineProps<{
  dataCommune: any,
  maxPonderation: number,
  territoire: string,
  dateDebut: string,
  dateFin: string,
}>();

const headers = ['Commune', 'Pourcentage', 'Pondération'];
const rows = ref([]);

async function downloadCsv() {
  const formatData = rows.value
    .map((r: any) => {
      return {
        commune: r[0],
        pourcentage: r[1].replace('%', ''),
        ponderation: r[2],
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
  a.download = `tableau_ponderation_commune_${props.dateDebut}_${props.dateFin}.csv`;
  a.click();
}

watch(() => [props.dataCommune], () => {
  if (!props.dataCommune || !props.maxPonderation) {
    return;
  }
  rows.value = props.dataCommune.map(c => {
    return [
      c.code,
      Math.min(c.ponderation / props.maxPonderation * 100, 100).toFixed(2) + '%',
      c.ponderation,
    ];
  });
}, { immediate: true });
</script>

<template>
  <AccessibleDataTable
    table-id="commune-drought-intensity-table"
    title="Intensité des sécheresses passées"
    :headers="headers"
    :rows="rows"
    fixed-layout
  />

  <div class="text-align-right fr-mt-1w">
    <DsfrButton @click="downloadCsv()">
      Télécharger les données (CSV)
    </DsfrButton>
  </div>
</template>
