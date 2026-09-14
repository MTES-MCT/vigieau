<script setup lang="ts">
import moment from 'moment';
import { downloadCsvFile } from '../../utils/csv-download';

import { RestrictionNiveauGraviteFr } from '../../dto/restriction.dto';
import { sortByDateDesc } from '../../utils/date-sort';
import { getStatisticRowStatusLabel, isProvisionalStatistic } from '../../utils/statistic-provisional';
import { isCommuneStatisticData } from '../../utils/statistic-series';

const props = defineProps<{
  dataCommune: any,
  disabled?: boolean,
  dateDebut: string,
  dateFin: string,
  communeNom: string,
}>();

const headers = computed(() => ['Date', 'Eau potable', 'Eau superficielle', 'Eau souterraine', ...(hasProvisionalData.value ? ['Statut'] : [])]);
const rows = ref([]);
const downloadingCsv = ref(false);
const csvDownloadError = ref(false);
const validData = computed(() => isCommuneStatisticData({ commune: { nom: props.communeNom }, restrictions: props.dataCommune }));
const hasProvisionalData = computed(() => validData.value && props.dataCommune.some(isProvisionalStatistic));
const canDownload = computed(() => !props.disabled && validData.value && props.dataCommune.length > 0);

async function downloadCsv() {
  if (!canDownload.value || downloadingCsv.value) {
    return;
  }
  downloadingCsv.value = true;
  csvDownloadError.value = false;
  const formatData = sortByDateDesc(props.dataCommune)
    .map((stat: any) => {
      return {
        date: stat.date,
        AEP: stat.AEP,
        SUP: stat.SUP,
        SOU: stat.SOU,
        ...(hasProvisionalData.value ? { statut: getStatisticRowStatusLabel(stat) } : {}),
      };
    });
  csvDownloadError.value = !await downloadCsvFile(formatData, `commune_${props.communeNom}_${props.dateDebut}_${props.dateFin}.csv`);
  downloadingCsv.value = false;
}

watch(() => [props.dataCommune], () => {
  if (!validData.value) {
    rows.value = [];
    return;
  }
  rows.value = sortByDateDesc(props.dataCommune).map(s => {
    return [
      moment(s.date).format('DD/MM/YYYY'),
      s.AEP ? RestrictionNiveauGraviteFr[s.AEP] : 'Pas de restrictions',
      s.SUP ? RestrictionNiveauGraviteFr[s.SUP] : 'Pas de restrictions',
      s.SOU ? RestrictionNiveauGraviteFr[s.SOU] : 'Pas de restrictions',
      ...(hasProvisionalData.value ? [getStatisticRowStatusLabel(s)] : []),
    ];
  });
}, { immediate: true });
</script>

<template>
  <AccessibleDataTable
    table-id="commune-restrictions-history-table"
    title="Évolution journalière du niveau de gravité de la commune"
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
