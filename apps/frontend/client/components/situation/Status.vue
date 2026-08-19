<script setup lang="ts">
import { useAddressStore } from '../../store/address';
import { storeToRefs } from 'pinia';
import { Ref } from 'vue';
import { useZoneStore } from '../../store/zone';
import utils from '../../utils';
import type { ZoneAvailability } from '../../dto/zone-availability.dto';
import { getZoneSituationState } from '../../utils/zone-availability';

const addressStore = useAddressStore();
const zoneStore = useZoneStore();
const { profile, typeEau } = storeToRefs(addressStore);
const { availability, zones } = storeToRefs(zoneStore);
const { resetAddress, adressString } = addressStore;
const { resetZones } = zoneStore;
const links: Ref<any[]> = ref([
  { to: '/', text: 'Accueil' },
  { text: 'Votre situation' },
]);
const zone = ref();
const zoneModal = ref();
const zoneModalError = ref('');
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
const situationUpdateAnnouncement = ref('');
const announcementsEnabled = ref(false);

const optionText = (
  options: Array<{ text: string; value: string }>,
  value: string,
) => options.find((option) => option.value === value)?.text ?? value;

const announceSituationUpdate = async (message: string) => {
  if (!announcementsEnabled.value) {
    return;
  }

  situationUpdateAnnouncement.value = '';
  await nextTick();
  situationUpdateAnnouncement.value = message;
};

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
  return (zone.value?.usages ?? []).filter((u) => {
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

const selectedAvailability = computed<ZoneAvailability>(() =>
  availability.value?.[typeEau.value] ?? { status: 'unavailable' },
);

const selectedSituationState = computed(() =>
  getZoneSituationState(zone.value, selectedAvailability.value),
);

const availabilityConfirmedNone = computed(
  () => selectedSituationState.value === 'confirmed_none',
);

const situationLabel = computed<string>(() => {
  if (selectedSituationState.value === 'unavailable') {
    return 'Information indisponible';
  }
  if (selectedSituationState.value === 'municipal') {
    return 'Arrêté municipal à consulter';
  }
  return utils.getShortSituationLabel(
    utils.getRestrictionRank(zone.value?.niveauGravite),
  );
});

const zoneModalOrigin = {
  focus: () => {
    const zoneSelect = document.getElementById('situation-alert-zone');
    const typeSelect = document.getElementById('situation-water-type');
    (zoneSelect || typeSelect)?.focus({ preventScroll: true });
  },
};

const selectZone = async () => {
  if (!zoneModal.value) {
    zoneModalError.value = 'Sélectionnez une zone d’alerte.';
    await nextTick();
    document.getElementById('situation-alert-zone-modal')?.focus();
    return;
  }

  const selectedZone = zones.value.find((z) => z.id === zoneModal.value);
  if (!selectedZone) {
    zoneModalError.value = 'La zone sélectionnée n’est plus disponible.';
    await nextTick();
    document.getElementById('situation-alert-zone-modal')?.focus();
    return;
  }

  zone.value = selectedZone;
  zoneModalError.value = '';
  zoneModal.value = null;
  modalOpened.value = false;
};

const closeZoneModal = () => {
  if (!modalOpened.value) {
    return;
  }

  modalOpened.value = false;
  router.push('/');
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

onMounted(() => {
  announcementsEnabled.value = true;
});

watch(
  () => typeEau.value,
  () => {
    if (zonesOptions.value.length <= 1) {
      zone.value = zones.value.find((z) => z.type === typeEau.value);
    } else {
      zone.value = undefined;
      zoneModal.value = null;
      zoneModalError.value = '';
      modalOpened.value = true;
    }
  },
  { immediate: true },
);

watch(
  [profile, typeEau, () => zone.value?.id],
  ([nextProfile, nextTypeEau, nextZoneId], [previousProfile, previousTypeEau, previousZoneId]) => {
    if (nextTypeEau !== previousTypeEau) {
      const waterType = optionText(typesEauOptions, nextTypeEau);
      const message = zonesOptions.value.length > 1
        ? `Sélectionnez une zone d’alerte pour l’eau ${waterType}.`
        : `Restrictions mises à jour pour l’eau ${waterType}.`;
      void announceSituationUpdate(message);
      return;
    }

    if (nextZoneId !== previousZoneId && zone.value) {
      void announceSituationUpdate(
        `Restrictions mises à jour pour la zone d’alerte « ${zone.value.nom} ».`,
      );
      return;
    }

    if (nextProfile !== previousProfile) {
      void announceSituationUpdate(
        `Restrictions mises à jour pour le profil ${optionText(profileOptions, nextProfile)}.`,
      );
    }
  },
  { flush: 'post' },
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
    <p
      id="situation-update-status"
      class="fr-sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {{ situationUpdateAnnouncement }}
    </p>

    <SituationHeader
      :address="addressToUse"
      :availability="selectedAvailability"
      :type-eau="typeEau"
      :zone="zone"
    />

    <div
      v-if="zone?.arreteMunicipalCheminFichier
        || zone?.arrete?.cheminFichier
        || zone?.arrete?.cheminFichierArreteCadre"
      class="fr-col-12"
    >
      <DocumentAccessibilityNotice />
    </div>

    <template v-if="utils.showRestrictions(zone)">
      <SituationRestrictions
        :profile="profile"
        :zone="zone"
        :usages="usagesByProfile"
      />
    </template>
    <template
      v-else-if="availabilityConfirmedNone && (!zone || !zone.arreteMunicipalCheminFichier)"
    >
      <div class="fr-col-12">
        <div class="fr-grid-row fr-grid-row--center">
          <DsfrHighlight class="fr-my-2w">
            <h3 class="fr-h3 fr-mb-1w">
              Besoin de précision sur les restrictions ?
            </h3>
            <p class="fr-mb-0">
              Votre mairie a pu renforcer ces restrictions, pensez à la
              consulter.
            </p>
          </DsfrHighlight>
        </div>
      </div>
    </template>
    <div class="fr-col-12 fr-grid-row fr-grid-row--center fr-mt-2w">
      <MixinsShare :situation-label="situationLabel" :address="addressToUse" />
    </div>
  </div>
  <AccessibleModal
    :opened="modalOpened"
    :actions="modalActions"
    :origin="zoneModalOrigin"
    initial-focus="#situation-alert-zone-modal"
    title="Pour consulter les restrictions, veuillez sélectionner la ressource dans laquelle vous prélevez de l’eau."
    @close="closeZoneModal"
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
        required
        :aria-invalid="zoneModalError ? 'true' : undefined"
        :aria-describedby="zoneModalError ? 'situation-alert-zone-modal-error' : undefined"
        @update:model-value="zoneModalError = ''"
      >
        <template #required-tip>
          <span class="required"> (obligatoire)</span>
        </template>
      </DsfrSelect>
      <p
        v-if="zoneModalError"
        id="situation-alert-zone-modal-error"
        class="fr-error-text"
      >
        {{ zoneModalError }}
      </p>
    </div>
  </AccessibleModal>
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
