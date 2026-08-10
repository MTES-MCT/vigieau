<script setup lang="ts">
import { useAddressStore } from '../../store/address';
import { storeToRefs } from 'pinia';
import { Ref } from 'vue';
import { useZoneStore } from '../../store/zone';
import utils from '../../utils';

const addressStore = useAddressStore();
const zoneStore = useZoneStore();
const { profile, typeEau } = storeToRefs(addressStore);
const { zones } = storeToRefs(zoneStore);
const { resetAddress, adressString } = addressStore;
const { resetZones } = zoneStore;
const links: Ref<any[]> = ref([
  { to: '/', text: 'Accueil' },
  { text: 'Votre situation' },
]);
const zone = ref();
const zoneModal = ref();
const modalOpened: Ref<boolean> = ref(false);
const router = useRouter();

const addressToUse: Ref<any> = ref(adressString());

const typesEauOptions = [
  {
    text: 'du robinet',
    value: 'AEP',
  },
  {
    text: `d'un cours d'eau, d'une rivière`,
    value: 'SUP',
  },
  {
    text: 'des nappes (puits ou forage)',
    value: 'SOU',
  },
];
const profileOptions = [
  {
    value: 'particulier',
    text: 'particulier',
  },
  {
    value: 'entreprise',
    text: 'professionnel',
  },
  {
    value: 'collectivite',
    text: 'collectivité',
  },
  {
    value: 'exploitation',
    text: 'exploitation agricole',
  },
];
const zonesOptions = computed(() => {
  return zones.value
    .filter((z) => z.type === typeEau.value)
    .map((z) => {
      return {
        value: z.id,
        text: z.nom,
      };
    });
});

const usagesByProfile = computed(() => {
  return zone.value.usages.filter((u) => {
    switch (profile.value) {
      case 'particulier':
        return u.concerneParticulier;
      case 'entreprise':
        return u.concerneEntreprise;
      case 'collectivite':
        return u.concerneCollectivite;
      case 'exploitation':
        return u.concerneExploitation;
      default:
        return false;
    }
  });
});

const situationLabel = computed<string>(() => {
  return utils.getShortSituationLabel(
    utils.getRestrictionRank(zone.value?.niveauGravite),
  );
});

const selectZone = () => {
  zone.value = zones.value.find((z) => z.id === zoneModal.value);
  zoneModal.value = null;
  modalOpened.value = false;
};

const updateZone = ($event) => {
  zone.value = zones.value.find((z) => z.id === $event);
};

const modalActions: Ref<any[]> = ref([
  { label: 'Valider', onClick: selectZone },
]);

onBeforeUnmount(() => {
  resetAddress();
  resetZones();
});

watch(
  () => typeEau.value,
  () => {
    if (zonesOptions.value.length <= 1) {
      zone.value = zones.value.find((z) => z.type === typeEau.value);
    } else {
      modalOpened.value = true;
    }
  },
  { immediate: true },
);
</script>

<template>
  <div
    v-if="addressToUse"
    class="situation-status fr-grid-row fr-grid-row--center fr-container"
  >
    <div class="fr-col-12">
      <AppBreadcrumb class="fr-mb-0" :links="links" />
    </div>
    <fieldset
      class="situation-status__selectors fr-col-12 fr-grid-row fr-grid-row--center fr-grid-row--middle fr-mb-1w"
    >
      <legend class="situation-status__selectors-legend fr-mb-1w">
        Adapter les restrictions affichées à votre situation
      </legend>
      <DsfrSelect
        v-model="typeEau"
        label="Type d’eau concerné"
        select-id="situation-water-type"
        :options="typesEauOptions"
      />
      <template v-if="zonesOptions.length > 1">
        <DsfrSelect
          label="Zone d’alerte concernée"
          select-id="situation-alert-zone"
          :model-value="zone?.id"
          :options="zonesOptions"
          @update:model-value="updateZone($event)"
        />
      </template>
      <DsfrSelect
        v-model="profile"
        label="Profil concerné"
        select-id="situation-profile"
        :options="profileOptions"
      />
    </fieldset>

    <SituationHeader :address="addressToUse" :type-eau="typeEau" :zone="zone" />

    <template v-if="utils.showRestrictions(zone)">
      <SituationRestrictions
        :profile="profile"
        :zone="zone"
        :usages="usagesByProfile"
      />
    </template>
    <template v-else-if="!zone || !zone.arreteMunicipalCheminFichier">
      <div class="fr-col-12">
        <div class="fr-grid-row fr-grid-row--center">
          <DsfrHighlight class="fr-my-2w">
            <b>Besoin de précision sur les restrictions ?</b>
            <br>
            Votre mairie a pu renforcer ces restrictions, pensez à la consulter.
          </DsfrHighlight>
        </div>
      </div>
    </template>
    <div class="fr-col-12 fr-grid-row fr-grid-row--center fr-mt-2w">
      <MixinsShare :situation-label="situationLabel" :address="addressToUse" />
    </div>
  </div>
  <DsfrModal
    :opened="modalOpened"
    :actions="modalActions"
    title="Pour consulter les restrictions, veuillez sélectionner la ressource dans laquelle vous prélevez de l’eau."
    @close="router.push('/')"
  >
    <div>
      <p class="fr-mx-1w fr-mb-0">
        Plusieurs cours d'eau sont référencés à cette adresse.
      </p>
      <DsfrSelect
        v-model="zoneModal"
        label="Zone d’alerte à consulter"
        select-id="situation-alert-zone-modal"
        :options="zonesOptions"
      />
    </div>
  </DsfrModal>
</template>

<style lang="scss">
.situation-status {
  &__selectors {
    column-gap: 1rem;
    min-width: 0;
    padding: 0;
    border: 0;

    &-legend {
      width: 100%;
      font-weight: 700;
      text-align: center;
    }
  }

  .fr-select {
    width: fit-content;
    max-width: 100%;

    &-group {
      margin-bottom: 0;
    }
  }
}

@media screen and (max-width: 767px) {
  .situation-status__selectors {
    row-gap: 1rem;

    .fr-select-group,
    .fr-select {
      width: 100%;
    }
  }
}
</style>
