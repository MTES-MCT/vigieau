<script setup lang="ts">
import api from '../../api';
import moment from 'moment';
import html2canvas from 'html2canvas';
import { helpers, required } from '@vuelidate/validators';
import useVuelidate from '@vuelidate/core';
import utils from '../../utils';

const props = defineProps<{
  codeInsee: string,
}>();

const emit = defineEmits<{
  commune: any;
}>();

const communeStats = ref(null);
const showError = ref(false);
const router = useRouter();
const route = useRoute();
const errorButtons = [
  {
    label: 'Page d\'accueil',
    onClick: () => {
      router.push('/');
    },
  },
];
const computeDisabled = ref(true);
const dateMin = ref('2013-01-01');
const tmp = new Date();
tmp.setFullYear(tmp.getFullYear() - 1);
const currentDate = ref(new Date().toISOString().split('T')[0]);
const loading = ref(false);
const statusMessage = ref('Chargement des données…');
const restrictionsFiltered = ref([]);
const screenshotZone = ref();

const typesEauOptions = [
  {
    text: 'Eau potable',
    value: 'AEP',
  },
  {
    text: `Eau superficielle`,
    value: 'SUP',
  }, {
    text: 'Eau souterraine',
    value: 'SOU',
  },
];

const formData = reactive({
  dateDebut: route.query.dateDebut ? moment(Math.max(moment(route.query.dateDebut), moment(dateMin.value))).format('YYYY-MM-DD') : dateMin.value,
  dateFin: route.query.dateFin ? moment(Math.min(moment(route.query.dateFin), moment())).format('YYYY-MM-DD') : new Date().toISOString().split('T')[0],
});
const rules = computed(() => {
  return {
    dateDebut: {
      required: helpers.withMessage('La date de début est obligatoire.', required),
      minValue: helpers.withMessage('La date de début doit être supérieure à Janvier 2013.', (val: string) => {
        if (val) {
          return moment(val, 'YYYY-MM-DD') >= moment(dateMin.value, 'YYYY-MM-DD');
        }
        return true;
      }),
      maxValue: helpers.withMessage('La date de début doit être inférieure à la date de fin.', (val: string) => {
        if (formData.dateFin && val) {
          return moment(val, 'YYYY-MM-DD') <= moment(formData.dateFin, 'YYYY-MM-DD');
        }
        return true;
      }),
      isValid: helpers.withMessage('La date de début doit être sous la forme YYYY-MM-DD (ex : 2024-01-01).', (val: string) => {
        if (val) {
          return moment(val, 'YYYY-MM-DD', true).isValid();
        }
        return true;
      }),
    },
    dateFin: {
      required: helpers.withMessage('La date de fin est obligatoire.', required),
      minValue: helpers.withMessage('La date de fin doit être supérieure à la date de début.', (val: string) => {
        if (formData.dateDebut && val) {
          return moment(val, 'YYYY-MM-DD') >= moment(formData.dateDebut, 'YYYY-MM-DD');
        }
        return true;
      }),
      maxValue: helpers.withMessage('La date de fin doit être inférieure à la date du jour.', (val: string) => {
        if (val) {
          return moment(val, 'YYYY-MM-DD') <= moment();
        }
        return true;
      }),
      isValid: helpers.withMessage('La date de fin doit être sous la forme YYYY-MM-DD (ex : 2024-01-01).', (val: string) => {
        if (val) {
          return moment(val, 'YYYY-MM-DD', true).isValid();
        }
        return true;
      }),
    },
  };
});

const v$ = useVuelidate(rules, formData);

onMounted(async () => {
  loading.value = true;
  statusMessage.value = 'Chargement des données…';
  const { data, error } = await api.getDataCommune(props.codeInsee);
  if (data.value) {
    communeStats.value = data.value;
    emit('commune', communeStats.value.commune);
    await sortData(false);
    statusMessage.value = resultStatusMessage();
  } else if (error.value) {
    showError.value = true;
    statusMessage.value = 'Le chargement des données de la commune a échoué.';
  }
  loading.value = false;
});

async function sortData(announce = true) {
  await v$.value.$validate();
  if (v$.value.$error) {
    return;
  }
  restrictionsFiltered.value = communeStats.value.restrictions.filter((r: any) => {
    return moment(r.date, 'YYYY-MM-DD').isSameOrAfter(moment(formData.dateDebut, 'YYYY-MM-DD')) &&
      moment(r.date, 'YYYY-MM-DD').isSameOrBefore(moment(formData.dateFin, 'YYYY-MM-DD'));
  });
  computeDisabled.value = true;
  if (announce) {
    statusMessage.value = resultStatusMessage();
  }
}

function resultStatusMessage() {
  const commune = communeStats.value?.commune?.nom || `la commune ${props.codeInsee}`;
  return `Données mises à jour pour ${commune}, du ${moment(formData.dateDebut).format('DD/MM/YYYY')} au ${moment(formData.dateFin).format('DD/MM/YYYY')}.`;
}

async function downloadGraph() {
  html2canvas(screenshotZone.value, { scale: 2 }).then((canvas) => {
    const content = canvas.toDataURL('image/png');

    const a = document.createElement('a');
    a.href = content.replace('image/png', 'image/octet-stream');
    a.download = `commune_${props.codeInsee}_${formData.dateDebut}_${formData.dateFin}.png`;
    a.click();
  });
}
</script>

<template>
  <p role="status" aria-live="polite" aria-atomic="true" class="fr-sr-only">
    {{ statusMessage }}
  </p>
  <div :aria-busy="loading">
    <template v-if="!loading">
      <template v-if="!showError && communeStats">
        <div ref="screenshotZone">
          <div class="fr-grid-row fr-grid-row--gutters fr-mb-2w">
            <div class="fr-col-lg-3 fr-col-md-6 fr-col-12">
              <DsfrInputGroup :error-message="utils.showInputError(v$, 'dateDebut')">
                <DsfrInput
                  id="dateDebut"
                  v-model="formData.dateDebut"
                  label="Date début"
                  label-visible
                  type="date"
                  name="dateCarte"
                  :min="dateMin"
                  :max="formData.dateFin"
                  required
                  @update:model-value="computeDisabled = false"
                />
              </DsfrInputGroup>
            </div>
            <div class="fr-col-lg-3 fr-col-md-6 fr-col-12">
              <DsfrInputGroup :error-message="utils.showInputError(v$, 'dateFin')">
                <DsfrInput
                  id="dateFin"
                  v-model="formData.dateFin"
                  label="Date fin"
                  label-visible
                  type="date"
                  name="dateCarte"
                  :min="formData.dateDebut"
                  :max="currentDate"
                  required
                  @update:model-value="computeDisabled = false"
                />
              </DsfrInputGroup>
            </div>
            <div data-html2canvas-ignore="true" class="fr-col-lg-3 fr-col-6">
              <DsfrButton
                :disabled="computeDisabled"
                @click="sortData()"
              >
                Calculer
              </DsfrButton>
            </div>
          </div>
          <MixinsNiveauGraviteLegende class="show-sm fr-mb-1w" />
          <h2 class="fr-mb-1w fr-h6">
            Tout type d'eau
          </h2>
          <p class="fr-text--sm">
            Niveau de gravité maximal observé parmi les niveaux de gravité relatifs aux eaux
            superficielles, souterraines et l'eau potable
          </p>
          <DonneesCommuneBarChart
            chart-id="commune-chart-all-water"
            title="Graphique pour tous les types d’eau"
            table-id="commune-restrictions-history-table"
            :restrictions="restrictionsFiltered"
            :commune-nom="communeStats.commune.nom"
          />
          <div v-for="typeEau of typesEauOptions" :key="typeEau.value">
            <h2 class="fr-mb-1w fr-h6">
              {{ typeEau.text }}
            </h2>
            <div v-if="typeEau.value === 'AEP'">
              <DsfrAlert
                title="Données historiques sur l’eau potable limitées"
                data-html2canvas-ignore="true"
                type="info"
                class="fr-my-2w"
              >
                Nous ne sommes pas en mesure de fournir les restrictions appliquées sur l'eau potable avant le 28/04/2024.
                Pour connaître les niveaux de restrictions en vigueur, veuillez vous référer aux niveaux de restrictions
                des eaux superficielles et souterraines.
              </DsfrAlert>
            </div>
            <DonneesCommuneBarChart
              :type-eau="typeEau.value"
              :chart-id="`commune-chart-${typeEau.value.toLowerCase()}`"
              :title="`Graphique pour ${typeEau.text.toLowerCase()}`"
              table-id="commune-restrictions-history-table"
              :restrictions="restrictionsFiltered"
              :commune-nom="communeStats.commune.nom"
            />
          </div>
          <MixinsNiveauGraviteLegende class="fr-mt-1w hide-sm" />
        </div>

        <div class="text-align-right fr-mt-1w">
          <DsfrButton @click="downloadGraph()">
            Télécharger le graphique en .png
          </DsfrButton>
        </div>

        <DonneesCommuneTable
          class="fr-mt-4w"
          :data-commune="restrictionsFiltered"
          :commune-nom="communeStats.commune.nom"
          :date-debut="formData.dateDebut"
          :date-fin="formData.dateFin"
        />
      </template>
      <template v-else>
        <DsfrErrorPage
          class="fr-mt-8w"
          title="Oups, une erreur est survenue"
          subtitle="Il semblerait qu'il y ai un problème avec le code INSEE de votre commune."
          description=""
          help=""
          :buttons="errorButtons"
        />
      </template>
    </template>
    <template v-else>
      <div class="fr-grid-row fr-grid-row--center fr-my-2w">
        <Loader :show="true" :announce="false" />
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.chart-container {
  max-height: 400px;
}

.fr-grid-row {
  align-items: end;
}
</style>
