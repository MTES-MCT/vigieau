<script setup lang="ts">
import { Ref } from 'vue';
import { downloadElementAsPng } from '../../../utils/png-download';

definePageMeta({
  layout: 'basic',
});

useHead({
  title: `Évolution par commune - ${useRuntimeConfig().public.appName}`,
});

const links: Ref<any[]> = ref([{ to: '/', text: 'Accueil' }, {
  text: 'Données sécheresse',
  to: '/donnees',
}, { text: 'Évolution de la situation de la sécheresse par commune' }]);
const filterData: any = ref(null);
const loading = ref(false);
const screenshotZone = ref();
const downloadingPng = ref(false);
const pngDownloadError = ref(false);

const setFilterData = (data: any) => {
  filterData.value = JSON.parse(JSON.stringify(data));
};

const downloadMap = async () => {
  if (downloadingPng.value) {
    return;
  }

  downloadingPng.value = true;
  pngDownloadError.value = false;
  try {
    await downloadElementAsPng(
      screenshotZone.value,
      `carte_evolution_${filterData.value?.areaText}_${filterData.value?.dateDebut}-${filterData.value?.dateFin}.png`,
      {
        scale: 2,
        useCORS: true,
        ignoreElements: (element) =>
          element.classList.contains('maplibregl-control-container'),
      },
    );
  } catch {
    pngDownloadError.value = true;
  } finally {
    downloadingPng.value = false;
  }
};
</script>

<template>
  <div class="fr-container">
    <AppBreadcrumb :links="links" />
    <h1>Intensité des sécheresses passées</h1>
    <p>Durée et gravité des situations de sécheresse sur un territoire (département ou commune) et une période
      donnée</p>
  </div>
  <div class="background-blue fr-py-2w">
    <div class="fr-container">
      <DonneesStatisticDataStatus />
      <div ref="screenshotZone">
        <CarteCommuneFilter :loading="loading"
                            @filterChange="setFilterData($event)" />
        <DsfrAlert
          title="Chargement de la carte"
          data-html2canvas-ignore="true"
          class="fr-my-2w"
          type="warning"
        >
          <p class="fr-mb-1w">
            La carte nationale peut prendre du temps à se charger. Si vous souhaitez ne visualiser qu'une partie du
            territoire, il est recommandé de restreindre l'affichage via le filtre territoire ou en zoomant sur la carte.
          </p>
          <p class="fr-mb-0">
            Pour plus de précisions sur la situation d'un département, n'hésitez pas à zoomer pour avoir les informations
            à la maille de la commune.
          </p>
        </DsfrAlert>
        <div style="position: relative;">
          <CarteCommuneMap :embedded="false"
                           :light="true"
                           :dateBegin="filterData?.dateDebut"
                           :dateEnd="filterData?.dateFin"
                           :area="filterData?.area"
                           :download-loading="downloadingPng"
                           @beginLoading="loading = true"
                           @endLoading="loading = false"
                           @downloadMap="downloadMap()" />
        </div>
      </div>
      <DsfrAlert
        v-if="pngDownloadError"
        title="Téléchargement impossible"
        class="fr-mt-2w"
        type="error"
        :closeable="false"
      >
        La génération de l’image PNG a échoué. Veuillez réessayer.
      </DsfrAlert>
    </div>
  </div>
</template>

<style lang="scss">
.background-blue {
  background-color: var(--blue-france-975-75);
}
</style>
