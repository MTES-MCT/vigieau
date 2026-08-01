<script setup lang="ts">
import type { ZonePublicationPin } from '../../api';
import { selectResponsivePublicationPin } from '../../utils/zone-source-transition';

const typeEau = ref('AEP');
const pointSelected = ref(null);
const profil = ref(null);
const desktopPublicationPin = ref<ZonePublicationPin | null>();
const mobilePublicationPin = ref<ZonePublicationPin | null>();
const desktopMapVisible = ref(false);
let desktopMediaQuery: MediaQueryList | null = null;

const displayedPublicationPin = computed(
  () =>
    selectResponsivePublicationPin(
      desktopMapVisible.value,
      desktopPublicationPin.value,
      mobilePublicationPin.value,
    ) ?? undefined,
);

const selectPointOnMap = (event: any) => {
  pointSelected.value = event;
};

const updateFormData = (formData: any) => {
  typeEau.value = formData.typeEau;
  profil.value = formData.profil;
};

const updateDesktopPublicationPin = (
  publicationPin: ZonePublicationPin | null,
) => {
  desktopPublicationPin.value = publicationPin;
};

const updateMobilePublicationPin = (
  publicationPin: ZonePublicationPin | null,
) => {
  mobilePublicationPin.value = publicationPin;
};

const updateVisibleMap = () => {
  desktopMapVisible.value = desktopMediaQuery?.matches ?? false;
};

onMounted(() => {
  desktopMediaQuery = window.matchMedia('(min-width: 62em)');
  updateVisibleMap();
  desktopMediaQuery.addEventListener('change', updateVisibleMap);
});

onBeforeUnmount(() => {
  desktopMediaQuery?.removeEventListener('change', updateVisibleMap);
  desktopMediaQuery = null;
});
</script>

<template>
  <div class="presentation fr-py-4w">
    <div class="fr-container">
      <div
        class="fr-grid-row fr-grid-row--gutters fr-grid-row--middle fr-mb-2w"
      >
        <div class="fr-col-12 text-align-center">
          <h1>Suis-je concerné par les restrictions ?</h1>
        </div>
        <div class="fr-col-lg-7 fr-hidden fr-unhidden-lg wrap-map">
          <CarteMap
            :embedded="false"
            :light="true"
            :hideDownloadBtn="true"
            :hideTypeEau="true"
            :typeEau="typeEau"
            :profil="profil"
            @displayedPublicationPin="updateDesktopPublicationPin"
            @selectPoint="selectPointOnMap($event)"
          />
        </div>

        <div class="search-card fr-col-12 fr-col-lg-5 fr-p-md-3w fr-p-1w">
          <div class="search-card-wrapper">
            <MixinsSearch
              @formData="updateFormData($event)"
              :publicationPin="displayedPublicationPin"
              :pointSelected="pointSelected"
            />
          </div>
        </div>

        <div class="fr-col-12 fr-hidden-lg wrap-map">
          <CarteMap
            :embedded="false"
            :light="true"
            :hideDownloadBtn="true"
            :hideTypeEau="true"
            :typeEau="typeEau"
            class="wrap-map"
            @displayedPublicationPin="updateMobilePublicationPin"
            @selectPoint="selectPointOnMap($event)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.presentation {
  background: var(--yellow-tournesol-975-75);
  background-image: url('/accueil_background.svg');
  background-size: cover;
  background-position: bottom;
}

.search-card {
  background-color: var(--background-default-grey);
  border: 1px var(--blue-cumulus-main-526) solid;
  border-radius: 15px;

  &-wrapper {
    max-width: 700px;
    margin: auto;
  }
}

.wrap-map {
  position: relative;
  width: 100%;
  height: 455px;
}

@media screen and (max-width: 767px) {
  .wrap-map {
    height: 90vh;
  }
}
</style>
