<script setup lang="ts">
import moment from 'moment';
import { downloadCsvFile } from '../../utils/csv-download';
import { isAreaStatisticSeries } from '../../utils/statistic-series';
import { sortByDateDesc } from '../../utils/date-sort';

const props = defineProps<{
  dataArea: any,
  disabled?: boolean,
  typeEau: any,
  territoire: string,
  dateDebut: string,
  dateFin: string,
}>();

const headers = ['Date', 'Vigilance', 'Alerte', 'Alerte renforcée', 'Crise'];
const rows = ref([]);
const downloadingCsv = ref(false);
const csvDownloadError = ref(false);
const validData = computed(() => isAreaStatisticSeries(props.dataArea, props.typeEau));
const canDownload = computed(() => !props.disabled && validData.value && props.dataArea.length > 0);

async function downloadCsv() {
  if (!canDownload.value || downloadingCsv.value) {
    return;
  }
  downloadingCsv.value = true;
  csvDownloadError.value = false;
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
  csvDownloadError.value = !await downloadCsvFile(formatData, `tableau_surface_${props.territoire}_${props.dateDebut}_${props.dateFin}_${props.typeEau}.csv`);
  downloadingCsv.value = false;
}

watch(() => [props.typeEau, props.dataArea], () => {
  if (!validData.value) {
    rows.value = [];
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
    <DsfrButton :disabled="!canDownload || downloadingCsv"
                :aria-busy="downloadingCsv ? 'true' : undefined"
                @click="downloadCsv()">
      Télécharger les données (CSV)
    </DsfrButton>
  </div>
  <DsfrAlert v-if="csvDownloadError" title="Téléchargement impossible" type="error" class="fr-mt-2w">
    La génération du fichier CSV a échoué. Veuillez réessayer.
  </DsfrAlert>
</template>
