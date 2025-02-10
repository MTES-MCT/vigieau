<script setup lang="ts">
import { helpers, required } from '@vuelidate/validators';
import useVuelidate from '@vuelidate/core';
import type { Restriction } from '~/dto/restriction.dto';
import type { ArreteCadre } from '~/dto/arrete_cadre.dto';
import type { Ref } from 'vue';
import type { UsageArreteCadre } from '~/dto/usage_arrete_cadre.dto';
import type { ArreteRestriction } from '~/dto/arrete_restriction.dto';
import { Parametres } from '~/dto/parametres.dto';

const props = defineProps<{
  restriction: Restriction;
  arreteCadre: ArreteCadre;
  arreteRestriction: ArreteRestriction;
  type: 'SUP' | 'SOU' | 'AEP';
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

const typesToShow = computed(() => {
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
const usagesSelected: Ref<string[]> = ref(props.restriction.usages.map((u) => u.nom));
const allUsages: Ref<any[]> = ref([]);
const api = useApi();
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
    allUsages.value.filter((u) => getNiveauGravite(u) !== null && getNiveauGravite(u) !== '').length :
    allUsages.value.length;
  return `Afficher les ${props.restriction.usages.length}/${allUsagesLength} usages`;
});

const modalOpened = ref(false);
const modalTitle = ref('');
const usageNameToEmit = ref();
const modalActions = ref([
  {
    label: 'Appliquer à toutes les zones',
    onclick: () => {
      emit('applyToAllRestrictions', usageNameToEmit.value);
      utils.closeModal(modalOpened);
    },
  },
  {
    label: 'Appliquer seulement à cette zone',
    secondary: true,
    onclick: () => {
      utils.closeModal(modalOpened);
    },
  },
]);

const onChange = ({ nom, checked }: { nom: string; checked: boolean }) => {
  usagesSelected.value = checked ? [...usagesSelected.value, nom] : usagesSelected.value.filter((val) => val !== nom);
  props.restriction.usages = allUsages.value.filter((u) => usagesSelected.value.includes(u.nom));
  if (!checked && props.multipleZones) {
    usageNameToEmit.value = nom;
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
  let restrictionUsages =
    props.restriction.usages.concat(
      props.arreteRestriction.restrictions
        .filter(r => r.id !== props.restriction.id)
        .map(r => r.usages
          .filter(u => !props.restriction.usages.some(ru => ru.nom === u.nom))
          .map((u) => {
            u.id = null;
            return u;
          }))
        .flat(),
    ).filter((value, index, self) =>
        index === self.findIndex((u) => (
          u.nom === value.nom && u.nom === value.nom
        )),
    );
  restrictionUsages = JSON.parse(JSON.stringify(restrictionUsages));
  if (!props.arreteCadre) {
    allUsages.value = restrictionUsages;
  } else {
    let usagesAc = props.arreteCadre.usages;
    usagesAc = usagesAc.filter((value, index, self) =>
        index === self.findIndex((t) => (
          t.nom === value.nom
        )),
    );
    allUsages.value = restrictionUsages.concat(usagesAc
      .filter((u) => !restrictionUsages.some(ru => ru.nom === u.nom))
      .map((u) => {
        u.id = null;
        return u;
      }),
    ).filter(u => {
      let bool = false;
      if (typesToShow.value.includes('SUP')) {
        bool = bool || u.concerneEsu;
      } else if (typesToShow.value.includes('SOU')) {
        bool = bool || u.concerneEso;
      } else if (typesToShow.value.includes('AEP')) {
        bool = bool || u.concerneAep;
      }
      return bool;
    });
  }
  allUsages.value = allUsages.value.sort((a, b) => {
    if (a.nom < b.nom) {
      return -1;
    }
    if (a.nom > b.nom) {
      return 1;
    }
    return 0;
  });
  allUsages.value = JSON.parse(JSON.stringify(allUsages.value));
  filterUsages();
};

const filterUsages = () => {
  props.restriction.usages = props.restriction.usages.filter(u => getNiveauGravite(u) !== null && getNiveauGravite(u) !== '');
  usagesSelected.value = props.restriction.usages.map((u) => u.nom);
};

computeAllUsages();

defineExpose({
  v$,
});

watch(() => props.restriction.usages, () => {
  usagesSelected.value = props.restriction.usages.map((u) => u.nom);
});

watch(() => props.restriction.niveauGravite, (newValue, oldValue) => {
  const selectedUsage = allUsages.value.filter(usage => {
    return usagesSelected.value.includes(usage.nom) && getNiveauGravite(usage) !== null && getNiveauGravite(usage) !== '';
  }).map(u => u.nom);
  const oldUsagesDisabledEnabled = allUsages.value.filter(usage => {
    return (getNiveauGravite(usage, oldValue ? oldValue : 'new') === null || getNiveauGravite(usage, oldValue ? oldValue : 'new') === '') &&
      getNiveauGravite(usage) !== null && getNiveauGravite(usage) !== '';
  }).map(u => u.nom);
  usagesSelected.value = [...new Set([selectedUsage, oldUsagesDisabledEnabled].flat())];
  props.restriction.usages = allUsages.value.filter((u) => usagesSelected.value.includes(u.nom));
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
            <div v-for="usageArreteCadre in allUsages">
              <DsfrCheckbox
                :id="'' + restriction.zoneAlerte?.id + restriction.nomGroupementAep + usageArreteCadre.nom"
                :key="'' + restriction.zoneAlerte?.id + restriction.nomGroupementAep + usageArreteCadre.nom"
                :name="usageArreteCadre.nom"
                :model-value="usagesSelected.includes(usageArreteCadre.nom)"
                :small="false"
                :disabled="getNiveauGravite(usageArreteCadre) === null || getNiveauGravite(usageArreteCadre) === ''"
                @update:model-value="onChange({ nom: usageArreteCadre.nom, checked: $event })"
              >
                <template #label>
                  <b>{{ usageArreteCadre.nom }}</b>
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
