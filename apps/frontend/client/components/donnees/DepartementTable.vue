<script setup lang="ts">
import moment from 'moment';
import { downloadCsvFile } from '../../utils/csv-download';
import { isDepartmentStatisticSeries } from '../../utils/statistic-series';
import { sortByDateDesc } from '../../utils/date-sort';

const props = defineProps<{
  dataDepartement: any,
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
const validData = computed(() => isDepartmentStatisticSeries(props.dataDepartement));
const canDownload = computed(() => !props.disabled && validData.value && props.dataDepartement.length > 0);

async function downloadCsv() {
  if (!canDownload.value || downloadingCsv.value) {
    return;
  }
  downloadingCsv.value = true;
  csvDownloadError.value = false;
  const formatData = sortByDateDesc(props.dataDepartement)
    .map((stat: any) => {
      return {
        date: stat.date,
        vigilance: stat.departements.reduce((acc: number, dep: any) => acc + (getNiveauGravite(dep) === 'vigilance' ? 1 : 0), 0),
        alerte: stat.departements.reduce((acc: number, dep: any) => acc + (getNiveauGravite(dep) === 'alerte' ? 1 : 0), 0),
        alerte_renforcee: stat.departements.reduce((acc: number, dep: any) => acc + (getNiveauGravite(dep) === 'alerte_renforcee' ? 1 : 0), 0),
        crise: stat.departements.reduce((acc: number, dep: any) => acc + (getNiveauGravite(dep) === 'crise' ? 1 : 0), 0),
      };
    });
  csvDownloadError.value = !await downloadCsvFile(formatData, `tableau_departements_${props.territoire}_${props.dateDebut}_${props.dateFin}_${props.typeEau}.csv`);
  downloadingCsv.value = false;
}

const getNiveauGravite = (departement: any) => {
  switch (props.typeEau) {
    case 'SUP':
      return departement.niveauGraviteSup;
    case 'SOU':
      return departement.niveauGraviteSou;
    case 'AEP':
      return departement.niveauGraviteAep;
    default:
      return departement.niveauGravite;
  }
};

watch(() => [props.typeEau, props.dataDepartement], () => {
  if (!validData.value) {
    rows.value = [];
    return;
  }
  rows.value = sortByDateDesc(props.dataDepartement).map(s => {
    return [
      moment(s.date).format('DD/MM/YYYY'),
      s.departements.reduce((acc: number, dep: any) => acc + (getNiveauGravite(dep) === 'vigilance' ? 1 : 0), 0),
      s.departements.reduce((acc: number, dep: any) => acc + (getNiveauGravite(dep) === 'alerte' ? 1 : 0), 0),
      s.departements.reduce((acc: number, dep: any) => acc + (getNiveauGravite(dep) === 'alerte_renforcee' ? 1 : 0), 0),
      s.departements.reduce((acc: number, dep: any) => acc + (getNiveauGravite(dep) === 'crise' ? 1 : 0), 0),
    ];
  });
}, { immediate: true });
</script>

<template>
  <AccessibleDataTable
    table-id="department-restrictions-history-table"
    title="Évolution journalière du nombre de départements soumis à restriction"
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
