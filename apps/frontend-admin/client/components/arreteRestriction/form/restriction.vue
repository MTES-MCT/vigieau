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
  getRestrictionUsageResetPreview,
  getRestrictionUsageSelectionState,
  getRestrictionUsagesForSeverity,
  haveEquivalentRestrictionUsageDefinition,
  haveSameRestrictionUsageMeasure,
  resetRestrictionUsagesFromFramework,
  type RestrictionWaterType,
  setRestrictionUsageChoice,
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
const frameworkUsages = computed(() => (props.arreteCadre?.usages ?? [])
  .filter((usage) => concernsAnyWaterType(usage, typesToShow.value)));
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
    allUsages.value.filter((u) => isUsageSelected(u) || hasCurrentInstruction(u)).length :
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
  props.restriction.usages.some((candidate) => haveEquivalentRestrictionUsageDefinition(candidate, usage));

const onChange = ({ usage, checked }: { usage: UsageArreteCadre; checked: boolean }) => {
  props.restriction.usages = setRestrictionUsageChoice(props.restriction, usage, checked);
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

const hasCurrentInstruction = (usage: UsageArreteCadre) => !!getNiveauGravite(usage)?.trim();

const computeAllUsages = () => {
  const selection = getRestrictionUsageSelectionState(props.restriction, frameworkUsages.value);
  const reusableUsages = selection.frameworkOnly ? [] : props.arreteRestriction.restrictions
    .filter((restriction) =>
      canReuseRestrictionUsages(
        restriction,
        props.restriction.id,
        props.arreteCadre?.id,
      ),
    )
    .flatMap((restriction) => restriction.usages);
  const candidates = selection.intended.concat(frameworkUsages.value, reusableUsages)
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

const getUsageScope = (usage: UsageArreteCadre) => {
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
  return `${profiles} ; ${resources}`;
};

const getUsageVariantLabel = (usage: UsageArreteCadre) => {
  const variants = allUsages.value.filter((candidate) => haveSameRestrictionUsageMeasure(candidate, usage));
  return variants.length < 2 ? '' : `Variante ${variants.indexOf(usage) + 1}/${variants.length} ; ${getUsageScope(usage)}`;
};

const getUsageOrigin = (usage: UsageArreteCadre) => {
  if (props.arreteCadre?.usages.some((candidate) => haveEquivalentRestrictionUsageDefinition(candidate, usage))) {
    return `Arrêté-cadre : ${props.arreteCadre.numero}`;
  }
  return 'Version reprise dans cet arrêté';
};

const resetModalOpened = ref(false);
const resetSides = ['before', 'after'] as const;
const resetChangeLabels = { added: 'Ajouté', removed: 'Retiré', changed: 'Remplacé' };
const getSelectedUsageCountLabel = (count: number) => `${count} ${count === 1 ? 'usage sélectionné' : 'usages sélectionnés'}`;
const resetPreview = computed(() => getRestrictionUsageResetPreview(
  getRestrictionUsageSelectionState(props.restriction, frameworkUsages.value).intended,
  frameworkUsages.value,
  props.restriction.niveauGravite,
));
const canResetUsages = computed(() => props.arreteRestriction.statut === 'a_valider' &&
  !!props.arreteCadre?.id && !!props.restriction.niveauGravite);
const resetUsages = () => {
  if (!canResetUsages.value) {
    return;
  }
  props.restriction.usages = resetRestrictionUsagesFromFramework(props.restriction, frameworkUsages.value);
  computeAllUsages();
  resetModalOpened.value = utils.closeModal(resetModalOpened);
};

computeAllUsages();

defineExpose({
  v$,
});

watch(() => props.restriction.usages, () => {
  props.restriction.usages.forEach((usage) => {
    if (!allUsages.value.some((candidate) => haveEquivalentRestrictionUsageDefinition(candidate, usage))) {
      allUsages.value.push(usage);
    }
  });
});

watch(() => props.restriction.niveauGravite, (newValue, oldValue) => {
  props.restriction.usages = getRestrictionUsagesForSeverity(
    props.restriction,
    frameworkUsages.value,
    newValue,
    oldValue,
  );
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
                :disabled="!isUsageSelected(usageArreteCadre) && !hasCurrentInstruction(usageArreteCadre)"
                @update:model-value="onChange({ usage: usageArreteCadre, checked: $event })"
              >
                <template #label>
                  <b class="full-width">{{ usageArreteCadre.nom }}</b>
                  <div v-if="getUsageVariantLabel(usageArreteCadre)" class="full-width fr-text--sm fr-mb-1w">
                    {{ getUsageVariantLabel(usageArreteCadre) }}
                  </div>
                  <div class="full-width">
                    {{ getNiveauGravite(usageArreteCadre) || 'Aucune consigne à ce niveau' }}
                  </div>
                </template>
              </DsfrCheckbox>
              <details v-if="getUsageVariantLabel(usageArreteCadre)" class="fr-ml-4w fr-mb-2w" data-cy="RestrictionUsageVariantDetails">
                <summary>{{ getUsageOrigin(usageArreteCadre) }} : consignes par niveau</summary>
                <dl class="fr-mt-1w fr-mb-0">
                  <template v-for="level in niveauGraviteOptions" :key="level.value">
                    <dt class="fr-text--bold">
                      {{ level.text }}
                    </dt>
                    <dd class="fr-ml-0 fr-mb-1w">
                      {{ getNiveauGravite(usageArreteCadre, level.value) || 'Aucune consigne' }}
                    </dd>
                  </template>
                </dl>
              </details>
              <div class="divider fr-mb-2w" />
            </div>
          </DsfrAccordion>
        </DsfrInputGroup>
        <DsfrButton
          v-if="arreteRestriction.statut === 'a_valider'"
          type="button"
          label="Reprendre les usages de l’arrêté-cadre"
          icon="ri-restart-line"
          secondary
          size="sm"
          class="fr-mb-2w restriction-usage-reset-button"
          data-cy="RestrictionUsageResetButton"
          :disabled="!canResetUsages"
          @click="resetModalOpened = true"
        />
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
  <DsfrModal
    :opened="resetModalOpened"
    title="Reprendre les usages de l’arrêté-cadre"
    size="lg"
    data-cy="RestrictionUsageResetDialog"
    @close="resetModalOpened = utils.closeModal(resetModalOpened)"
  >
    <p>
      <strong>{{ restriction.zoneAlerte?.nom || restriction.nomGroupementAep }}</strong><br>
      Arrêté-cadre : {{ arreteCadre?.numero }}
    </p>
    <p>
      Les adaptations de cette zone seront remplacées par les usages de cet arrêté-cadre.
      Les autres zones et l’arrêté source ne seront pas modifiés.
    </p>
    <p class="fr-text--bold">
      Avant : {{ getSelectedUsageCountLabel(restriction.usages.length) }}.
      Après : {{ getSelectedUsageCountLabel(resetPreview.usages.length) }} au niveau actuel.
    </p>
    <div data-cy="RestrictionUsageResetPreview">
      <p v-if="!resetPreview.groups.length">
        Les usages sélectionnés correspondent déjà à ceux de l’arrêté-cadre.
      </p>
      <details v-for="(group, groupIndex) in resetPreview.groups" :key="groupIndex" class="fr-mb-2w">
        <summary>{{ resetChangeLabels[group.change] }} : {{ group.name }}</summary>
        <div class="restriction-usage-reset-columns fr-mt-1w">
          <div v-for="side in resetSides" :key="side">
            <h3 class="fr-h6">
              {{ side === 'before' ? 'Avant' : 'Après' }}
            </h3>
            <p v-if="!group[side].length">
              Aucun usage
            </p>
            <div v-for="(usage, usageIndex) in group[side]" :key="usageIndex" class="fr-mb-2w">
              <p class="fr-mb-1w">
                <strong>{{ usage.nom }}</strong><br>
                {{ getUsageScope(usage) }}
              </p>
              <dl class="fr-m-0">
                <template v-for="level in niveauGraviteOptions" :key="level.value">
                  <dt class="fr-text--bold">
                    {{ level.text }}
                  </dt>
                  <dd class="fr-ml-0 fr-mb-1w">
                    {{ getNiveauGravite(usage, level.value) || 'Aucune consigne' }}
                  </dd>
                </template>
              </dl>
            </div>
          </div>
        </div>
      </details>
    </div>
    <template #footer>
      <ul class="fr-btns-group fr-btns-group--inline-md">
        <li>
          <DsfrButton
            label="Annuler"
            secondary
            data-cy="RestrictionUsageResetCancel"
            @click="resetModalOpened = utils.closeModal(resetModalOpened)"
          />
        </li>
        <li>
          <DsfrButton
            label="Confirmer le remplacement"
            icon="ri-restart-line"
            data-cy="RestrictionUsageResetConfirm"
            :disabled="!canResetUsages"
            @click="resetUsages"
          />
        </li>
      </ul>
    </template>
  </DsfrModal>
</template>

<style lang="scss">
.restriction-usage-reset-columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 1.5rem;
  overflow-wrap: anywhere;

  > div {
    min-width: 0;
  }

  @media (min-width: 48rem) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.restriction-line {
  align-items: center;

  .restriction-usage-reset-button {
    max-width: 100%;
    white-space: normal;
    text-align: left;
  }

  .fr-select-group {
    margin-bottom: 0;
  }
}

.fr-link {
  background: none;
}
</style>
