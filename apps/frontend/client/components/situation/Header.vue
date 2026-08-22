<script setup lang="ts">
import utils from '../../utils';
import { Zone } from '../../dto/zone.dto';
import { useAddressStore } from '../../store/address';
import niveauxGravite from '../../dto/niveauGravite';
import type { ZoneAvailability } from '../../dto/zone-availability.dto';
import {
  formatZoneAvailabilityDate,
  getZoneSituationState,
} from '../../utils/zone-availability';
import { VIcon } from '@gouvminint/vue-dsfr';

const props = defineProps<{
  typeEau: 'AEP' | 'SUP' | 'SOU',
  zone: Zone
  address: string
  availability: ZoneAvailability
}>();

const addressStore = useAddressStore();
const { isParticulier } = addressStore;

const badgeLabel = (rank: number | undefined, showRank: boolean = false) => {
  return showRank ? utils.getSituationBadgeLabel(rank) : utils.getShortSituationLabel(rank);
};

const classObject = (rank: number | undefined): any => {
  const bgClass = `situation-level-bg-${rank}`;
  const colorClass = `situation-level-c-${rank}`;
  const cssClass: any = {
    'situation-disabled': utils.getRestrictionRank(props.zone?.niveauGravite) !== rank,
  };
  cssClass[bgClass] = true;
  cssClass[colorClass] = utils.getRestrictionRank(props.zone?.niveauGravite) !== rank;
  return cssClass;
};

const situationLabel = computed<string>(() => {
  return utils.getShortSituationLabel(utils.getRestrictionRank(props.zone?.niveauGravite));
});

const typeEauLabels = {
  AEP: 'L\'eau potable',
  SOU: 'L\'eau prélevée dans les nappes',
  SUP: 'L\'eau prélevée dans les cours d\'eau',
} as const;
const typeEauLabel = computed(() => typeEauLabels[props.typeEau]);
const situationState = computed(() =>
  getZoneSituationState(props.zone, props.availability),
);
const availabilityUnavailable = computed(
  () => situationState.value === 'unavailable',
);
const availabilityConfirmedNone = computed(
  () => situationState.value === 'confirmed_none',
);
const municipalOnly = computed(() => situationState.value === 'municipal');
const availabilityUpdating = computed(
  () => props.availability.freshness === 'updating',
);
const availabilityUpdatedAt = computed(() =>
  formatZoneAvailabilityDate(props.availability.asOf),
);
const niveauGravite = computed(() => {
  return niveauxGravite.find(n => n.niveauGravite === (props.zone?.niveauGravite ? props.zone.niveauGravite : null));
});
</script>

<template>
  <div
    class="situation-status-header fr-grid-row fr-py-4w"
    :class="`situation-level-${utils.getRestrictionRank(zone?.niveauGravite)}`"
  >
    <div
      class="fr-col-12 situation-status-header__info-wrapper"
      :class="!zone?.id ? 'fr-col-md-8' : ''"
    >
      <div class="fr-mb-2w fr-grid-row fr-grid-row--middle">
        <DsfrBadge
          v-if="situationState === 'restricted' || availabilityConfirmedNone"
          small
          no-icon
          :class="classObject(utils.getRestrictionRank(zone?.niveauGravite))"
          :label="badgeLabel(utils.getRestrictionRank(zone?.niveauGravite))"
        />
        <VIcon class="fr-mx-1w" name="ri-map-pin-user-line" />
        {{ address }}
      </div>
      <h1 v-if="availabilityUnavailable" class="h2">
        Les restrictions pour {{ typeEauLabel.toLowerCase() }}
        <span>ne peuvent pas être confirmées</span>
        à votre adresse.
      </h1>
      <h1 v-else-if="zone?.id" class="h2">
        {{ typeEauLabel }} est en
        <span
          :class="`situation-level-c-${utils.getRestrictionRank(zone?.niveauGravite)}`"
        >
          {{ situationLabel }}
        </span>
        à votre adresse.
      </h1>
      <h1 v-else-if="municipalOnly" class="h2">
        Un arrêté municipal concernant l’eau
        <span>a été publié pour votre commune</span>.
      </h1>
      <h1 v-else-if="availabilityConfirmedNone" class="h2">
        {{ typeEauLabel }} n'est
        <span class="situation-level-c-0">
          pas concernée par des restrictions
        </span>
        à votre adresse.
      </h1>
      <p
        v-if="!availabilityUnavailable && (availabilityUpdatedAt || availabilityUpdating)"
        class="fr-text--sm fr-mt-1w fr-mb-0 situation-status-header__freshness"
      >
        <template v-if="availabilityUpdatedAt">
          Situation au {{ availabilityUpdatedAt }}
        </template>
        <template v-if="availabilityUpdating">
          <span v-if="availabilityUpdatedAt"> · </span>Mise à jour en cours
        </template>
      </p>
    </div>
    <div
      v-if="availabilityUnavailable"
      class="fr-col-12 situation-status-header__info-wrapper"
    >
      <p class="fr-m-0">
        La requête n’a pas permis de vérifier la situation. Consultez
        <a
          v-if="availability.officialUrl"
          class="fr-link"
          :href="availability.officialUrl"
          target="_blank"
          rel="noopener external"
        >
          le site internet des services de l’État
        </a><template v-else>
          le site internet des services de l’État de votre département
        </template>.
      </p>
    </div>
    <div
      v-else-if="municipalOnly"
      class="fr-col-12 situation-status-header__info-wrapper"
    >
      <p class="fr-m-0">
        Consultez l’arrêté municipal pour connaître les restrictions applicables.
      </p>
    </div>
    <div v-else class="fr-col-12 situation-status-header__info-wrapper">
      <p class="fr-m-0">{{ niveauGravite.description }}</p>
    </div>
    <div
      v-if="!availabilityUnavailable && !utils.showRestrictions(zone) && isParticulier()"
      class="fr-col-12 fr-col-md-8 situation-status-header__info-wrapper"
    >
      <p class="fr-m-0">Nous vous conseillons tout de même de suivre les eco-gestes ci-dessous.</p>
    </div>
    <div v-if="zone?.arreteMunicipalCheminFichier" class="fr-col-12 fr-mt-2w">
      <DsfrAlert
        title="Un arrêté municipal a été publié par votre collectivité"
        type="info"
        :closeable="false"
      >
        Certaines restrictions peuvent avoir été renforcées.
        <a
          class="fr-link"
          :href="zone.arreteMunicipalCheminFichier"
          target="_blank"
          rel="external"
        >
          Consultez l'arrêté municipal
        </a>
      </DsfrAlert>
    </div>
  </div>
</template>

<style scoped lang="scss">
.situation-status-header {
  position: relative;
  margin: auto;

  &:before {
    content: "";
    position: absolute;
    width: 100vw;
    height: 100%;
    left: 50%;
    top: 0;
    -webkit-transform: translateX(-50%);
    transform: translateX(-50%);
    z-index: -1;
  }

  &.situation-level {
    &-4:before {
      background: linear-gradient(270deg, var(--pink-macaron-925-125), var(--pink-macaron-850-200));
      opacity: 0.5;
    }

    &-3:before {
      background: linear-gradient(270deg, var(--yellow-tournesol-975-75), var(--pink-macaron-925-125));
      opacity: 0.5;
    }

    &-2:before {
      background: linear-gradient(270deg, var(--yellow-moutarde-975-75), var(--yellow-moutarde-950-100));
      opacity: 0.3;
    }

    &-1:before {
      background: linear-gradient(270deg, var(--yellow-moutarde-975-75), var(--blue-ecume-975-75));
      opacity: 0.5;
    }

    &-0:before {
      background: linear-gradient(270deg, var(--info-950-100), var(--blue-france-975-75));
    }
  }

  .situation-disabled {
    background-color: var(--grey-1000-50);
  }

  h1 {
    span {
      text-transform: lowercase;
    }
  }

  &__btn-wrapper {
    text-align: right;
  }

  &__freshness {
    color: var(--text-mention-grey);
  }
}

@media screen and (max-width: 767px) {
  .situation-status-header {
    &:before {
      width: 100%;
      left: 0;
      -webkit-transform: none;
      transform: none;
    }

    &__btn-wrapper, &__info-wrapper {
      text-align: center;
    }

    &__info-wrapper .fr-grid-row {
      justify-content: center;
    }
  }
}
</style>
