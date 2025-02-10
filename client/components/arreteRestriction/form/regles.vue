<script setup lang="ts">
import { helpers, required } from '@vuelidate/validators/dist';
import useVuelidate from '@vuelidate/core';
import { requiredIf } from '@vuelidate/validators';
import type { ArreteRestriction } from '~/dto/arrete_restriction.dto';

const props = defineProps<{
  arreteRestriction: ArreteRestriction;
}>();

const rules = computed(() => {
  return {
    perimetreAr: {
      required: helpers.withMessage("La règle de gestion de l'eau potable est obligatoire.", required),
    },
    niveauGraviteSpecifiqueEap: {
      requiredIf: helpers.withMessage(
        "La règle de gestion de l'eau potable est obligatoire.",
        requiredIf(() => props.arreteRestriction.perimetreAr == 'all'),
      ),
    },
    ressourceEapCommunique: {
      requiredIf: helpers.withMessage(
        "La niveau de gravité de l'eau potable est obligatoire.",
        requiredIf(() => props.arreteRestriction.niveauGraviteSpecifiqueEap == false),
      ),
    },
  };
});

const utils = useUtils();

const perimetreArOptions = [
  {
    label: 'Zones Eaux souterraines (ESO) et/ou Eaux superficielles (ESU)',
    value: 'zones',
  },
  {
    label: 'Zones d\'approvisionnement en eau potable (AEP)',
    value: 'aep',
  },
  {
    label: 'Les trois',
    value: 'all',
  },
];
const niveauGraviteSpecifiqueEapOptions = [
  {
    label: 'Oui, je souhaite créer des périmètres géographiques spécifiques à l’eau potable.',
    value: true,
  },
  {
    label: 'Non, les niveaux de gravité ESO/ESU s’appliquent à l’ensemble des usages y compris l’eau potable.',
    value: false,
  },
];
const ressourceEapCommuniqueOptions = [
  {
    label: 'Eaux superficielles (ESU)',
    value: 'esu',
  },
  {
    label: 'Eaux souterraines (ESO)',
    value: 'eso',
  },
  {
    label: 'Le niveau de gravité maximal',
    value: 'max',
  },
];

const v$ = useVuelidate(rules, props.arreteRestriction);

defineExpose({
  v$,
});

watch(
  () => props.arreteRestriction.perimetreAr,
  () => {
    props.arreteRestriction.niveauGraviteSpecifiqueEap = null;
    if (props.arreteRestriction.perimetreAr == 'all') {
      return;
    } else if (props.arreteRestriction.perimetreAr === 'zones') {
      props.arreteRestriction.restrictions = props.arreteRestriction.restrictions.filter((r) => !r.isAep);
    } else {
      props.arreteRestriction.restrictions = props.arreteRestriction.restrictions.filter((r) => r.isAep);
    }
  },
);

watch(
  () => props.arreteRestriction.niveauGraviteSpecifiqueEap,
  () => {
    if (props.arreteRestriction.niveauGraviteSpecifiqueEap === false) {
      props.arreteRestriction.restrictions = props.arreteRestriction.restrictions.filter((r) => !r.isAep);
    } else {
      props.arreteRestriction.ressourceEapCommunique = null;
    }
  },
);
</script>

<template>
  <form @submit.prevent="">
    <div class="fr-grid-row fr-grid-row--gutters">
      <div class="fr-col-12 fr-col-lg-6">
        <DsfrInputGroup :error-message="utils.showInputError(v$, 'perimetreAr')">
          <DsfrRadioButtonSet
            legend="Dans cet arrêté de restriction, sur quels types de ressources comptez-vous appliquer des restrictions ?"
            :options="perimetreArOptions"
            v-model="arreteRestriction.perimetreAr"
            name="perimetreAr"
            :small="false"
          />
        </DsfrInputGroup>

        <DsfrInputGroup
          v-if="arreteRestriction.perimetreAr == 'all'"
          :error-message="utils.showInputError(v$, 'niveauGraviteSpecifiqueEap')"
        >
          <DsfrRadioButtonSet
            legend="Souhaitez-vous différencier les niveaux de gravité eau potable des niveaux de gravité ESU / ESO ?"
            :options="niveauGraviteSpecifiqueEapOptions"
            v-model="arreteRestriction.niveauGraviteSpecifiqueEap"
            name="niveauGraviteSpecifiqueEap"
            :small="false"
          />
        </DsfrInputGroup>

        <DsfrInputGroup
          v-if="arreteRestriction.niveauGraviteSpecifiqueEap == false"
          :error-message="utils.showInputError(v$, 'ressourceEapCommunique')"
        >
          <DsfrRadioButtonSet
            legend="Pour une localisation géographique donnée, un seul niveau de gravité sera communiqué pour l'eau potable. Précisez quel niveau de gravité s'applique à l'eau potable si des zones ESU et ESO se superposent ?"
            :options="ressourceEapCommuniqueOptions"
            v-model="arreteRestriction.ressourceEapCommunique"
            name="ressourceEapCommunique"
            :small="false"
          />
        </DsfrInputGroup>
        <div class="divider" />
      </div>
      <div class="fr-col-12 fr-col-lg-6">
        <DsfrAlert
          type="info"
          title="Information"
          description="Vous allez pouvoir créer une ou plusieurs zones pour l'eau potable à l’aide des codes INSEE des communes ou en choisissant le département en entier"
        />
      </div>
    </div>
  </form>
</template>
