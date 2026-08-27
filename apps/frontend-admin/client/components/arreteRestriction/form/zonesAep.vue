<script setup lang="ts">
import type { ArreteRestriction } from '~/dto/arrete_restriction.dto';
import useVuelidate from '@vuelidate/core';
import { helpers } from '@vuelidate/validators';
import type { Ref } from 'vue';
import { Restriction } from '~/dto/restriction.dto';
import type { Commune } from '~/dto/commune.dto';
import { useRefDataStore } from '~/stores/refData';

const props = defineProps<{
  arreteRestriction: ArreteRestriction;
  selected: boolean;
}>();
const modalCommunesOpened = ref(false);
const modalActions = ref();
const expandedId = ref();
const loading = ref(false);

const rules = computed(() => {
  return {
    restrictions: {
      required: helpers.withMessage("L'arrêté doit être lié à au moins une zone d'alerte AEP.", () => {
        return props.arreteRestriction.restrictions.filter((r) => r.isAep).length > 0;
      }),
      different: helpers.withMessage(`Les zones AEP sélectionnées contiennent des doublons de communes.`, () => {
        const communesId = props.arreteRestriction.restrictions
          .filter((r) => r.isAep)
          .map((r) => (r.communes ?? []).map((c) => c.id))
          .flat();
        const doublons = communesId.filter((item, index) => communesId.indexOf(item) !== index);
        doublonCommunes.value = communes.value.filter((c) => doublons.includes(c.id));
        return doublons.length < 1;
      }),
    },
  };
});

const utils = useUtils();
const refDataStore = useRefDataStore();
const communes: Ref<Commune[]> = ref([]);
const doublonCommunes: Ref<Commune[]> = ref([]);
const groupementToEdit: Ref<Restriction | undefined> = ref();
const groupementCommunesFormRef = ref(null);
const zonesAep: Ref<Restriction[]> = ref(props.arreteRestriction.restrictions.filter((r) => r.isAep));
const zoneKeys = new WeakMap<Restriction, string>();
let nextTemporaryZoneKey = 0;
const getZoneKey = (restriction: Restriction): string => {
  const existing = zoneKeys.get(restriction);
  if (existing) {
    return existing;
  }
  if (restriction.id) {
    const key = `id:${restriction.id}`;
    zoneKeys.set(restriction, key);
    return key;
  }
  nextTemporaryZoneKey += 1;
  const key = `new:${nextTemporaryZoneKey}`;
  zoneKeys.set(restriction, key);
  return key;
};
const selectedZoneKeys: Ref<string[]> = ref(zonesAep.value.map(getZoneKey));
const editedZoneKey: Ref<string | null> = ref(null);

const isFullDepartement = ref(null);
const canComputeFullDepartement = ref(true);
modalActions.value = [
  {
    label: 'Enregistrer',
    onclick: () => {
      groupementCommunesFormRef.value?.submitForm();
    },
  },
  {
    label: 'Annuler',
    secondary: true,
    onclick: () => {
      utils.closeModal(modalCommunesOpened);
    },
  },
];

const communesAssociated = computed(() => {
  return props.arreteRestriction.restrictions
    .filter((r) => r.isAep)
    .map((r) => r.communes ?? [])
    .flat().length;
});

const createEditGroupementCommunes = (restriction = null, isFullDepartement = false) => {
  const r = restriction !== null ? JSON.parse(JSON.stringify(restriction)) : new Restriction(true);
  if (isFullDepartement) {
    r.nomGroupementAep = 'Zone AEP départementale';
    r.communes = communes.value.map((c) => {
      return { id: c.id, code: c.code, nom: c.nom };
    });
  }
  groupementToEdit.value = r;
  editedZoneKey.value = restriction ? getZoneKey(restriction) : null;
  modalCommunesOpened.value = true;
};

const createEditGroupement = async (restriction: Restriction) => {
  restriction.nomGroupementAep = (restriction.nomGroupementAep ?? '').trim();
  if (editedZoneKey.value === null) {
    props.arreteRestriction.restrictions.push(restriction);
    zonesAep.value.push(restriction);
    selectedZoneKeys.value = [...selectedZoneKeys.value, getZoneKey(restriction)];
  } else {
    zoneKeys.set(restriction, editedZoneKey.value);
    const idx = props.arreteRestriction.restrictions.findIndex((r) => r.isAep && getZoneKey(r) === editedZoneKey.value);
    if (idx >= 0) {
      props.arreteRestriction.restrictions[idx] = restriction;
    }
    const idxBis = zonesAep.value.findIndex((r) => r.isAep && getZoneKey(r) === editedZoneKey.value);
    if (idxBis >= 0) {
      zonesAep.value[idxBis] = restriction;
    }
  }
  sortRestrictions();
  sortCommunes();
  editedZoneKey.value = null;
  utils.closeModal(modalCommunesOpened);
};

const onChange = ({ name, checked }: { name: string; checked: boolean }) => {
  selectedZoneKeys.value = checked ? [...selectedZoneKeys.value, name] : selectedZoneKeys.value.filter((value) => value !== name);
};

const sortRestrictions = () => {
  props.arreteRestriction.restrictions = props.arreteRestriction.restrictions.sort((a, b) => {
    if (a.nomGroupementAep < b.nomGroupementAep) {
      return -1;
    }
    if (a.nomGroupementAep > b.nomGroupementAep) {
      return 1;
    }
    return 0;
  });
};

const sortCommunes = () => {
  props.arreteRestriction.restrictions
    .filter((r) => r.communes)
    .forEach((r) => {
      r.communes = r.communes?.sort((a, b) => {
        if (a.code < b.code) {
          return -1;
        }
        if (a.code > b.code) {
          return 1;
        }
        return 0;
      });
    });
};

const showErrorMessage = computed(() => {
  let errorMessage = utils.showInputError(v$.value, 'restrictions');
  if (doublonCommunes.value.length > 0) {
    errorMessage += ` Les communes suivantes sont présentes dans plusieurs zones AEP : ${doublonCommunes.value.map((c) => `${c.code} ${c.nom}`).join(', ')}`;
  }
  return errorMessage;
});

const v$ = useVuelidate(rules, { isFullDepartement });

defineExpose({
  v$,
});

const loadCommunes = async () => {
  const depCode = props.arreteRestriction.departement?.code;
  if (!depCode) {
    communes.value = [];
    return;
  }

  loading.value = true;
  try {
    await refDataStore.ensureCommunesLoaded([depCode]);
    const regex = new RegExp(`^(${depCode})`);
    communes.value = refDataStore.communes.filter((c) => regex.test(c.code));
    const restrictionsAep = props.arreteRestriction.restrictions.filter((r) => r.isAep);
    if (restrictionsAep.length > 0) {
      canComputeFullDepartement.value = false;
      isFullDepartement.value = restrictionsAep.length < 2 && communesAssociated.value === communes.value.length;
    }
  } finally {
    loading.value = false;
  }
};

watch(() => props.arreteRestriction.departement, loadCommunes, { immediate: true });

watch(selectedZoneKeys, () => {
  const zonesAepSelected = zonesAep.value.filter((r) => selectedZoneKeys.value.includes(getZoneKey(r)));
  props.arreteRestriction.restrictions = props.arreteRestriction.restrictions.filter(
    (r) => !r.isAep || selectedZoneKeys.value.includes(getZoneKey(r)),
  );
  const newZones = zonesAepSelected.filter((z) => !props.arreteRestriction.restrictions.some((r) => getZoneKey(r) === getZoneKey(z)));
  newZones.forEach((z) => {
    props.arreteRestriction.restrictions.push(z);
  });
  sortRestrictions();
  sortCommunes();
});
</script>

<template>
  <form @submit.prevent="">
    <div class="zone-alerte-aep fr-grid-row fr-grid-row--gutters">
      <div class="fr-col-12 fr-col-lg-6">
        <h6>Définition des zones AEP</h6>

        <p v-if="loading" class="fr-mt-2w">
          <VIcon name="ri-loader-4-line" animation="spin" />
          Chargement des communes...
        </p>

        <div v-if="communes.length > 0" class="form-group fr-fieldset fr-mt-2w">
          <DsfrInputGroup class="full-width" :error-message="showErrorMessage">
            <template v-for="r in zonesAep" :key="getZoneKey(r)">
              <DsfrCheckbox
                :id="getZoneKey(r)"
                :name="getZoneKey(r)"
                :model-value="selectedZoneKeys.includes(getZoneKey(r))"
                :small="false"
                @update:model-value="onChange({ name: getZoneKey(r), checked: $event })"
              >
                <template #label>
                  <DsfrButton
                    :label="r.nomGroupementAep"
                    :tertiary="true"
                    :no-outline="false"
                    icon="ri-edit-2-fill"
                    icon-right
                    @click.stop="createEditGroupementCommunes(r)"
                  />
                </template>
              </DsfrCheckbox>

              <DsfrAccordion
                v-if="r.communes"
                class="full-width fr-accordion--no-shadow"
                :title="`Voir les ${r.communes.length} communes`"
                :expanded-id="expandedId"
                @expand="expandedId = $event"
              >
                <span v-for="c of r.communes" :key="c.id"> {{ c.code }} - {{ c.nom }}<br /> </span>
              </DsfrAccordion>
              <div class="divider fr-mb-2w" />
            </template>
          </DsfrInputGroup>
        </div>
        <ul class="fr-btns-group">
          <li>
            <DsfrButton
              label="Ajouter un groupement de communes"
              secondary
              :icon="loading ? { name: 'ri-loader-4-line', animation: 'spin' } : ''"
              :iconRight="true"
              @click="createEditGroupementCommunes()"
              :disabled="loading || communesAssociated >= communes.length"
            />
          </li>
          <li>
            <DsfrButton
              label="Ajouter toutes les communes du département"
              secondary
              @click="createEditGroupementCommunes(null, true)"
              :disabled="loading || communes.length <= 0 || selectedZoneKeys.length > 0"
            />
          </li>
        </ul>
      </div>
    </div>
  </form>
  <DsfrModal
    :opened="modalCommunesOpened"
    title="Création / édition d'un groupement de communes"
    :actions="modalActions"
    @close="modalCommunesOpened = utils.closeModal(modalCommunesOpened)"
  >
    <ArreteRestrictionFormGroupementCommunes
      :restriction="groupementToEdit"
      ref="groupementCommunesFormRef"
      :communes="communes"
      :zonesAep="zonesAep"
      :arretesCadre="arreteRestriction.arretesCadre"
      @createEdit="createEditGroupement($event)"
    />
  </DsfrModal>
</template>

<style lang="scss">
.zone-alerte-aep {
  .fr-checkbox-group {
    margin-top: 1rem;

    input[type='checkbox'] + label {
      margin-left: 0;
      padding-right: 3rem;

      &::before {
        left: auto;
        right: 0.5rem;
      }

      .checkbox-label-info {
        display: block;
        color: var(--info-425-625);
        width: 100%;
      }
    }
  }
}
</style>
