<script setup lang="ts">
import moment from 'moment';
import { json2csv } from 'json-2-csv';
import { RestrictionNiveauGraviteFr } from '../../dto/restriction.dto';
import { sortByDateDesc } from '../../utils/date-sort';

const props = defineProps<{
  dataCommune: any,
  dateDebut: string,
  dateFin: string,
  communeNom: string,
}>();

const headers = ['Date', 'Eau potable', 'Eau superficielle', 'Eau souterraine'];
const rows = ref([]);

async function downloadCsv() {
  const formatData = sortByDateDesc(props.dataCommune)
    .map((stat: any) => {
      return {
        date: stat.date,
        AEP: stat.AEP,
        SUP: stat.SUP,
        SOU: stat.SOU,
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
  a.download = `commune_${props.communeNom}_${props.dateDebut}_${props.dateFin}.csv`;
  a.click();
}

watch(() => [props.dataCommune], () => {
  if(!props.dataCommune) {
    return;
  }
  rows.value = sortByDateDesc(props.dataCommune).map(s => {
    return [
      moment(s.date).format('DD/MM/YYYY'),
      s.AEP ? RestrictionNiveauGraviteFr[s.AEP] : 'Pas de restrictions',
      s.SUP ? RestrictionNiveauGraviteFr[s.SUP] : 'Pas de restrictions',
      s.SOU ? RestrictionNiveauGraviteFr[s.SOU] : 'Pas de restrictions',
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
    :row-header-column="0"
    table-class="fr-table--sm"
    fixed-layout
  />

  <div class="text-align-right fr-mt-1w">
    <DsfrButton @click="downloadCsv()">
      Télécharger les données (CSV)
    </DsfrButton>
  </div>
</template>
