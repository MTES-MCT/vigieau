<script setup lang="ts">
import { nextTick, Ref } from 'vue';
import {
  createLocalDateRollover,
  formatLocalCivilDate,
} from '../../utils/zone-publication';
import type { LocalDateRollover } from '../../utils/zone-publication';
import type { ZonePublicationPin } from '../../api';

withDefaults(defineProps<{
  embedded: any;
  headingTag?: 'h1' | 'h2';
}>(), {
  headingTag: 'h2',
});

const tabs = [
  { id: 'map', label: 'Carte' },
  { id: 'data', label: 'Données' },
];
const selectedTabIndex: Ref<number> = ref(0);
const dateCarte = ref(formatLocalCivilDate());
const displayedPublicationPin = ref<ZonePublicationPin | null>(null);
let localDateRollover: LocalDateRollover | null = null;

const updateDisplayedPublicationPin = (
  publicationPin: ZonePublicationPin | null,
) => {
  displayedPublicationPin.value = publicationPin;
};

const showDataAlternative = async () => {
  selectedTabIndex.value = 1;
  await nextTick();
  document.getElementById('restrictions-tab-data')?.focus();
};

onMounted(() => {
  dateCarte.value = formatLocalCivilDate();
  localDateRollover = createLocalDateRollover((currentDate) => {
    dateCarte.value = currentDate;
  });
});

onBeforeUnmount(() => {
  localDateRollover?.stop();
});
</script>

<template>
  <div :class="embedded ? '' : 'fr-py-4w'">
    <div class="fr-container">
      <div class="fr-mb-4w">
        <component :is="headingTag" class="fr-mb-0">
          Carte des restrictions
        </component>
        <p>Arrêtés publiés avant le {{ dateCarte }}</p>
        <p id="restrictions-map-instructions" class="fr-mb-2w">
          La carte interactive se déplace avec les flèches et se zoome avec
          les touches + et −. Appuyez sur Entrée ou Espace pour sélectionner
          le point situé au centre. Une alternative accessible est disponible
          sous forme de tableau.
        </p>
        <DsfrButton secondary type="button" @click="showDataAlternative">
          Consulter les données sous forme de tableau
        </DsfrButton>
      </div>
      <AccessibleTabs
        v-model="selectedTabIndex"
        id-prefix="restrictions"
        label="Présentation des restrictions"
        :tabs="tabs"
      >
        <template #map>
          <div class="wrap-map">
            <CarteMap
              :embedded="embedded"
              :date="dateCarte"
              profil="particulier"
              type-eau="AEP"
              accessible-description-id="restrictions-map-instructions"
              @displayed-publication-pin="updateDisplayedPublicationPin"
            />
          </div>
        </template>
        <template #data>
          <CarteTable
            :date="dateCarte"
            :publication-pin="displayedPublicationPin"
          />
        </template>
      </AccessibleTabs>
    </div>
  </div>
</template>

<style scoped lang="scss">
.fr-tabs {
  box-shadow: none;
  overflow: visible;

  &:before {
    box-shadow: none;
  }

  :deep(.fr-tabs__panel) {
    padding: 0;
    z-index: 1;
    overflow: visible;

    &:last-child {
      background-color: var(--background-alt-grey);
    }
  }
}

.wrap-map {
  position: relative;
  width: 100%;
  height: calc(100vh - 250px);
}

@media screen and (max-width: 767px) {
  .wrap-map {
    height: 90vh;
  }
}
</style>
