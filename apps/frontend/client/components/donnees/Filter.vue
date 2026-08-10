<script setup lang="ts">
import { BassinVersant } from '../../dto/bassinVersant.dto';
import { Region } from '../../dto/region.dto';
import { Departement } from '../../dto/departement.dto';
import { useRefDataStore } from '../../store/refData';
import {
  createLocalDateRollover,
  formatLocalCivilDate,
} from '../../utils/zone-publication';
import type { LocalDateRollover } from '../../utils/zone-publication';

const emit = defineEmits<{
  filterChange: any;
}>();

const refDataStore = useRefDataStore();
const date = ref(formatLocalCivilDate());
const currentDate = ref(formatLocalCivilDate());
const area = ref('');
const computeDisabled = ref(true);
let localDateRollover: LocalDateRollover | null = null;

const areaOptions = ref([]);

const loadData = (() => {
  const areaText = areaOptions.value.find(a => a.value === area.value)?.text;
  emit('filterChange', {
    date: date.value,
    area: area.value,
    areaText,
  });
  computeDisabled.value = true;
});

onMounted(() => {
  const initialCurrentDate = currentDate.value;
  currentDate.value = formatLocalCivilDate();
  if (date.value === initialCurrentDate) {
    date.value = currentDate.value;
  }
  localDateRollover = createLocalDateRollover(
    (nextCurrentDate, previousCurrentDate) => {
      currentDate.value = nextCurrentDate;
      if (computeDisabled.value && date.value === previousCurrentDate) {
        date.value = nextCurrentDate;
        loadData();
      }
    },
  );
  loadData();
});

onBeforeUnmount(() => {
  localDateRollover?.stop();
});

watch(() => refDataStore.departements, () => {
  areaOptions.value = [{
    text: 'France entière',
    value: '',
  }];
  areaOptions.value.push({
    text: 'Bassins Versants',
    disabled: true,
  });
  refDataStore.bassinsVersants.forEach((b: BassinVersant) => {
    areaOptions.value.push({
      text: b.nom,
      value: `bassinVersant=${b.id}`,
    });
  });
  areaOptions.value.push({
    text: 'Régions',
    disabled: true,
  });
  refDataStore.regions.forEach((r: Region) => {
    areaOptions.value.push({
      text: r.nom,
      value: `region=${r.id}`,
    });
  });
  areaOptions.value.push({
    text: 'Départements',
    disabled: true,
  });
  refDataStore.departements.forEach((d: Departement) => {
    areaOptions.value.push({
      text: d.nom,
      value: `departement=${d.id}`,
    });
  });
}, {
  immediate: true,
});
</script>

<template>
  <div class="fr-grid-row fr-grid-row--gutters">
    <div class="fr-col-lg-4 fr-col-md-6 fr-col-12">
      <DsfrSelect label="Territoire"
                  v-model="area"
                  @update:modelValue="computeDisabled = false"
                  :options="areaOptions"
                  required />
    </div>
    <div class="fr-col-lg-4 fr-col-md-6 fr-col-12">
      <DsfrInput
        id="dateCarte"
        v-model="date"
        @update:modelValue="computeDisabled = false"
        label="Filtrer par date"
        label-visible
        type="date"
        name="dateCarte"
        min="2012-01-01"
        :max="currentDate"
        required
      />
    </div>
    <div data-html2canvas-ignore="true" class="fr-col-lg-3 fr-col-6">
      <DsfrButton :disabled="computeDisabled"
                  @click="loadData()">
        Calculer
      </DsfrButton>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.fr-grid-row {
  align-items: end;

  :deep(.fr-select) {
    option:disabled {
      font-weight: bold;
    }
  }
}
</style>
