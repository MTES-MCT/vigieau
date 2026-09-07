<script setup lang="ts">
import { helpers, required } from '@vuelidate/validators';
import useVuelidate from '@vuelidate/core';
import type { Restriction } from '~/dto/restriction.dto';
import type { ArreteCadre } from '~/dto/arrete_cadre.dto';
import { type Ref, useId } from 'vue';
import type { UsageArreteCadre } from '~/dto/usage_arrete_cadre.dto';
import type { ArreteRestriction } from '~/dto/arrete_restriction.dto';
import { Parametres } from '~/dto/parametres.dto';
import {
  canReuseRestrictionUsages,
  concernsAnyWaterType,
  getRestrictionUsageOptions,
  haveSameRestrictionUsageDefinition,
  type RestrictionWaterType,
  setRestrictionUsageSelected,
} from '~/utils/restriction-usage';

const props = defineProps<{
  restriction: Restriction;
  arreteCadre: ArreteCadre;
  arreteRestriction: ArreteRestriction;
  type: RestrictionWaterType;
  multipleZones: boolean;
  departementParametres: Parametres;
}>();

const emit = defineEmits<{
  applyToAllRestrictions: any;
}>();

const rules = computed(() => {
  return {
    niveauGravite: {
      required: helpers.withMessage('La zone d\'alerte doit avoir un niveau de gravité.', required),
    },
    // usagesArreteRestriction: {
    //   required: helpers.withMessage("La zone d'alerte doit être liée à au moins un usage.", required),
    // },
  };
});

const typesToShow = computed<RestrictionWaterType[]>(() => {
  switch (props.departementParametres?.superpositionCommune) {
    case 'no':
    case 'no_all':
    case 'yes_only_aep':
    case 'yes_distinct':
      if (props.arreteRestriction.ressourceEapCommunique === 'max') {
        if (props.type === 'SUP') {
          return ['SUP', 'AEP'];
        } else if (props.type === 'SOU') {
          return ['SOU', 'AEP'];
        }
      }
      if (props.arreteRestriction.ressourceEapCommunique === 'esu' && props.type === 'SUP') {
        return ['SUP', 'AEP'];
      }
      if (props.arreteRestriction.ressourceEapCommunique === 'eso' && props.type === 'SOU') {
        return ['SOU', 'AEP'];
      }
      break;
    case 'yes_all':
      return ['SUP', 'SOU', 'AEP'];
    case 'yes_except_aep':
      if (props.type === 'SUP' || props.type === 'SOU') {
        if (props.arreteRestriction.ressourceEapCommunique === 'max' ||
          (props.arreteRestriction.ressourceEapCommunique === 'esu' && props.type === 'SUP') ||
          (props.arreteRestriction.ressourceEapCommunique === 'eso' && props.type === 'SOU')) {
          return ['SUP', 'SOU', 'AEP'];
        }
        return ['SUP', 'SOU'];
      }
      break;
  }
  if (props.type === 'SUP') {
    return ['SUP'];
  } else if (props.type === 'SOU') {
    return ['SOU'];
  } else {
    return ['AEP'];
  }
});
const allUsages: Ref<UsageArreteCadre[]> = ref([]);
const checkboxPrefix = useId();
const checkboxIds = new WeakMap<UsageArreteCadre, string>();
let nextCheckboxId = 0;
const utils = useUtils();

const v$ = useVuelidate(rules, props.restriction);

const niveauGraviteOptions = [
  {
    text: 'Vigilance',
    value: 'vigilance',
  },
  {
    text: 'Alerte',
    value: 'alerte',
  },
  {
    text: 'Alerte renforcée',
    value: 'alerte_renforcee',
  },
  {
    text: 'Crise',
    value: 'crise',
  },
];
const expandedId = ref();

const accordionTitle = computed(() => {
  const allUsagesLength = props.restriction.niveauGravite ?
    allUsages.value.filter((u) => isUsageSelected(u) || (getNiveauGravite(u) !== null && getNiveauGravite(u) !== '')).length :
    allUsages.value.length;
  const selectedUsagesLength = allUsages.value.filter(isUsageSelected).length;
  return `Afficher les ${selectedUsagesLength}/${allUsagesLength} usages`;
});

const modalOpened = ref(false);
const modalTitle = ref('');
const usageToEmit = ref<UsageArreteCadre>();
const modalActions = ref([
  {
    label: 'Appliquer seulement à cette zone',
    onclick: () => {
      utils.closeModal(modalOpened);
    },
  },
  {
    label: 'Appliquer à toutes les zones',
    secondary: true,
    onclick: () => {
      emit('applyToAllRestrictions', usageToEmit.value);
      utils.closeModal(modalOpened);
    },
  },
]);

const isUsageSelected = (usage: UsageArreteCadre) =>
  props.restriction.usages.some((candidate) => haveSameRestrictionUsageDefinition(candidate, usage));

const onChange = ({ usage, checked }: { usage: UsageArreteCadre; checked: boolean }) => {
  props.restriction.usages = setRestrictionUsageSelected(props.restriction.usages, usage, checked);
  if (!checked && props.multipleZones) {
    usageToEmit.value = usage;
    modalTitle.value = `Souhaitez-vous ${checked ? 'cocher' : 'décocher'} cet usage sur toutes les zones d’alertes de même ressource ?`;
    modalOpened.value = true;
  }
};

const getNiveauGravite = (usageArreteCadre: UsageArreteCadre, niveauGravite?: string | null) => {
  switch (niveauGravite ? niveauGravite : props.restriction.niveauGravite) {
    case 'vigilance':
      return usageArreteCadre.descriptionVigilance;
    case 'alerte':
      return usageArreteCadre.descriptionAlerte;
    case 'alerte_renforcee':
      return usageArreteCadre.descriptionAlerteRenforcee;
    case 'crise':
      return usageArreteCadre.descriptionCrise;
    default:
      return null;
  }
};

const computeAllUsages = () => {
  const reusableUsages = props.arreteRestriction.restrictions
    .filter((restriction) =>
      canReuseRestrictionUsages(
        restriction,
        props.restriction.id,
        props.arreteCadre?.id,
      ),
    )
    .flatMap((restriction) => restriction.usages);
  const candidates = reusableUsages.concat(props.arreteCadre?.usages ?? [])
    .filter((usage) => concernsAnyWaterType(usage, typesToShow.value));
  allUsages.value = getRestrictionUsageOptions(props.restriction.usages, candidates);
  allUsages.value = allUsages.value.sort((a, b) => {
    if (a.nom < b.nom) {
      return -1;
    }
    if (a.nom > b.nom) {
      return 1;
    }
    return 0;
  });
};

const getUsageCheckboxId = (usage: UsageArreteCadre) => {
  if (!checkboxIds.has(usage)) {
    checkboxIds.set(usage, `${checkboxPrefix}-usage-${nextCheckboxId++}`);
  }
  return checkboxIds.get(usage);
};

const getUsageVariantLabel = (usage: UsageArreteCadre) => {
  const variants = allUsages.value.filter((candidate) => candidate.nom === usage.nom);
  if (variants.length < 2) {
    return '';
  }
  const profiles = [
    usage.concerneParticulier && 'Particuliers',
    usage.concerneEntreprise && 'Entreprises',
    usage.concerneCollectivite && 'Collectivités',
    usage.concerneExploitation && 'Exploitations agricoles',
  ].filter(Boolean).join(', ');
  const resources = [
    usage.concerneEsu && 'eaux superficielles',
    usage.concerneEso && 'eaux souterraines',
    usage.concerneAep && 'eau potable',
  ].filter(Boolean).join(', ');
  const crisisLabel = usage.descriptionCrise || 'sans consigne de crise';
  return `Variante ${variants.indexOf(usage) + 1}/${variants.length} ; ${profiles} ; ${resources} ; crise : ${crisisLabel}`;
};

computeAllUsages();

defineExpose({
  v$,
});

watch(() => props.restriction.usages, () => {
  props.restriction.usages.forEach((usage) => {
    if (!allUsages.value.some((candidate) => haveSameRestrictionUsageDefinition(candidate, usage))) {
      allUsages.value.push(usage);
    }
  });
});

watch(() => props.restriction.niveauGravite, (newValue, oldValue) => {
  let selectedUsages = props.restriction.usages.filter((usage) => getNiveauGravite(usage) !== null && getNiveauGravite(usage) !== '');
  const oldUsagesDisabledEnabled = allUsages.value.filter(usage => {
    return (getNiveauGravite(usage, oldValue ? oldValue : 'new') === null || getNiveauGravite(usage, oldValue ? oldValue : 'new') === '') &&
      getNiveauGravite(usage) !== null && getNiveauGravite(usage) !== '';
  });
  oldUsagesDisabledEnabled.forEach((usage) => {
    selectedUsages = setRestrictionUsageSelected(selectedUsages, usage, true);
  });
  props.restriction.usages = selectedUsages;
});
</script>

<template>
  <form @submit.prevent="">
    <div class="fr-grid-row fr-grid-row--space-between restriction-line">
      <div class="fr-col-8">
        <template v-if="restriction.isAep">
          {{ restriction.nomGroupementAep }}
        </template>
        <template v-else> {{ restriction.zoneAlerte.code }} {{ restriction.zoneAlerte.nom }}</template>
        <DsfrTooltip v-if="restriction.zoneAlerte?.ressourceInfluencee"
                     on-hover 
                     content="Ressource influencée">
          <DsfrBadge label="RI"
                     @click="$event.preventDefault();"
                     class="fr-ml-2w fr-badge--no-icon" />
        </DsfrTooltip>
      </div>
      <div class="fr-col-4">
        <DsfrInputGroup :error-message="utils.showInputError(v$, 'niveauGravite')">
          <DsfrSelect
            id="niveauGravite"
            v-model="restriction.niveauGravite"
            :options="niveauGraviteOptions"
            defaultUnselectedText="Niveau de gravité *"
            type="text"
            name="niveauGravite"
          />
        </DsfrInputGroup>
      </div>
      <div class="fr-col-12 fr-grid-row">
        <DsfrInputGroup class="full-width"
                        :error-message="utils.showInputError(v$, 'usagesArreteRestriction')">
          <DsfrAccordion :title="accordionTitle"
                         :expanded-id="expandedId"
                         @expand="expandedId = $event"
                         class="fr-accordion--no-shadow">
            <div v-for="usageArreteCadre in allUsages" :key="getUsageCheckboxId(usageArreteCadre)">
              <DsfrCheckbox
                :id="getUsageCheckboxId(usageArreteCadre)"
                :name="getUsageCheckboxId(usageArreteCadre)"
                :model-value="isUsageSelected(usageArreteCadre)"
                :small="false"
                :disabled="!isUsageSelected(usageArreteCadre) && (getNiveauGravite(usageArreteCadre) === null || getNiveauGravite(usageArreteCadre) === '')"
                @update:model-value="onChange({ usage: usageArreteCadre, checked: $event })"
              >
                <template #label>
                  <b>{{ usageArreteCadre.nom }}</b>
                  <div v-if="getUsageVariantLabel(usageArreteCadre)" class="fr-text--sm fr-mb-1w">
                    {{ getUsageVariantLabel(usageArreteCadre) }}
                  </div>
                  <div class="full-width">
                    {{ getNiveauGravite(usageArreteCadre) }}
                  </div>
                </template>
              </DsfrCheckbox>
              <div class="divider fr-mb-2w" />
            </div>
          </DsfrAccordion>
        </DsfrInputGroup>
      </div>
    </div>
  </form>
  <DsfrModal
    :opened="modalOpened"
    :title="modalTitle"
    :actions="modalActions"
    @close="modalOpened = utils.closeModal(modalOpened);"
  >
    Vous pouvez choisir d’appliquer ou non votre action à toutes les autres zones d’alertes de même ressource.
  </DsfrModal>
</template>

<style lang="scss">
.restriction-line {
  align-items: center;

  .fr-select-group {
    margin-bottom: 0;
  }
}

.fr-link {
  background: none;
}
</style>
