<script setup lang="ts">
import { Ref } from 'vue';
import html2canvas from 'html2canvas';

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
const statusMessage = ref('Sélectionnez un territoire et une période, puis lancez le calcul.');
const screenshotZone = ref();

const setFilterData = (data: any) => {
  filterData.value = JSON.parse(JSON.stringify(data));
  statusMessage.value = 'Chargement des données de la carte…';
};

const beginLoading = () => {
  loading.value = true;
  statusMessage.value = 'Chargement des données de la carte…';
};

const endLoading = () => {
  loading.value = false;
  statusMessage.value = `Données mises à jour pour ${filterData.value?.areaText || 'France entière'}, du ${filterData.value?.dateDebut} au ${filterData.value?.dateFin}.`;
};

const downloadMap = () => {
  html2canvas(screenshotZone.value, {
    scale: 2, useCORS: true, ignoreElements: (element) => {
      return element.classList.contains('maplibregl-control-container');
    },
  }).then((canvas) => {
    const content = canvas.toDataURL('image/png');

    const a = document.createElement('a');
    a.href = content.replace('image/png', 'image/octet-stream');
    a.download = `carte_evolution_${filterData.value?.areaText}_${filterData.value?.dateDebut}-${filterData.value?.dateFin}.png`;
    a.click();
  });
};
</script>

<template>
  <div class="fr-container">
    <AppBreadcrumb :links="links" />
    <h1>Intensité des sécheresses passées</h1>
    <p>Durée et gravité des situations de sécheresse sur un territoire (département ou commune) et une période
      donnée</p>
    <p role="status" aria-live="polite" aria-atomic="true" class="fr-sr-only">
      {{ statusMessage }}
    </p>
  </div>
  <div class="background-blue fr-py-2w">
    <div class="fr-container">
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
        <div style="position: relative;" :aria-busy="loading">
          <CarteCommuneMap :embedded="false"
                           :light="true"
                           :dateBegin="filterData?.dateDebut"
                           :dateEnd="filterData?.dateFin"
                           :area="filterData?.area"
                           @beginLoading="beginLoading"
                           @endLoading="endLoading"
                           @downloadMap="downloadMap()" />
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss">
.background-blue {
  background-color: var(--blue-france-975-75);
}
</style>
