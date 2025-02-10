<script setup lang="ts">
import type { ArreteRestriction } from '~/dto/arrete_restriction.dto';
import useVuelidate from '@vuelidate/core';
import { helpers, required } from '@vuelidate/validators';
import type { Ref } from 'vue';
import { Restriction } from '~/dto/restriction.dto';
import type { Commune } from '~/dto/commune.dto';

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
      required: helpers.withMessage('L\'arrêté doit être lié à au moins une zone d\'alerte AEP.', () => {
        return props.arreteRestriction.restrictions.filter((r) => r.isAep).length > 0;
      }),
      different: helpers.withMessage(`Les zones AEP sélectionnées contiennent des doublons de communes.`, () => {
        const communesId = props.arreteRestriction.restrictions
          .filter((r) => r.isAep)
          .map((r) => r.communes.map((c) => c.id))
          .flat();
        const doublons = communesId.filter((item, index) => communesId.indexOf(item) !== index);
        doublonCommunes.value = communes.value.filter((c) => doublons.includes(c.id));
        return doublons.length < 1;
      }),
    },
  };
});

const utils = useUtils();
const api = useApi();
const communes: Ref<Commune[]> = ref([]);
const doublonCommunes: Ref<Commune[]> = ref([]);
const groupementToEdit: Ref<Restriction | undefined> = ref();
const groupementCommunesFormRef = ref(null);
const zonesAep: Ref<Restriction[]> = ref(props.arreteRestriction.restrictions.filter((r) => r.isAep));
const zonesSelected: Ref<string[]> = ref(zonesAep.value.map((r) => r.nomGroupementAep));
const groupemenantNameEdited: Ref<string | null> = ref(null);

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
    .map((r) => r.communes)
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
  groupemenantNameEdited.value = restriction ? r.nomGroupementAep : null;
  modalCommunesOpened.value = true;
};

const createEditGroupement = async (restriction: Restriction) => {
  if (groupemenantNameEdited.value === null) {
    props.arreteRestriction.restrictions.push(restriction);
    zonesAep.value.push(restriction);
    zonesSelected.value = [...zonesSelected.value, restriction.nomGroupementAep];
  } else {
    const idx = props.arreteRestriction.restrictions.findIndex(r => r.isAep && r.nomGroupementAep === groupemenantNameEdited.value);
    props.arreteRestriction.restrictions[idx] = restriction;
    const idxBis = zonesAep.value.findIndex(r => r.isAep && r.nomGroupementAep === groupemenantNameEdited.value);
    zonesAep.value[idxBis] = restriction;
  }
  sortRestrictions();
  sortCommunes();
  groupemenantNameEdited.value = null;
  utils.closeModal(modalCommunesOpened);
};

const onChange = ({ name, checked }: { name: string; checked: boolean }) => {
  zonesSelected.value = checked ? [...zonesSelected.value, name] : zonesSelected.value.filter((val) => val !== name);
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
    .filter(r => r.communes)
    .forEach(r => {
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
  if(doublonCommunes.value.length > 0) {
    errorMessage += ` Les communes suivantes sont présentes dans plusieurs zones AEP : ${doublonCommunes.value.map(c => c.code + ' ' + c.nom).join(', ')}`;
  }
  return errorMessage;
});

const v$ = useVuelidate(rules, { isFullDepartement });

defineExpose({
  v$,
});

watch(
  () => props.arreteRestriction.departement,
  async () => {
    const query = `depCode=${props.arreteRestriction.departement?.code}`;
    loading.value = true;
    const { data, error } = await api.commune.list(query);
    if (data.value) {
      communes.value = data.value;
      const restrictionsAep = props.arreteRestriction.restrictions.filter((r) => r.isAep);
      if (restrictionsAep.length > 0) {
        canComputeFullDepartement.value = false;
        isFullDepartement.value = restrictionsAep.length < 2 && communesAssociated.value === communes.value.length;
      }
    }
    loading.value = false;
  },
  { immediate: true },
);

watch(zonesSelected, () => {
  const zonesAepSelected = zonesAep.value.filter((r) => zonesSelected.value.includes(r.nomGroupementAep));
  props.arreteRestriction.restrictions = props.arreteRestriction.restrictions.filter(
    (r) => !r.isAep || zonesSelected.value.includes(r.nomGroupementAep),
  );
  const newZones = zonesAepSelected.filter(
    (z) => !props.arreteRestriction.restrictions.some((r) => r.nomGroupementAep === z.nomGroupementAep),
  );
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

        <div v-if="communes.length > 0" class="form-group fr-fieldset fr-mt-2w">
          <DsfrInputGroup class="full-width"
                          :error-message="showErrorMessage">
            <template v-for="(r) in zonesAep">
              <DsfrCheckbox
                :id="r.id || r.nomGroupementAep"
                :name="r.nomGroupementAep"
                :model-value="zonesSelected.includes(r.nomGroupementAep)"
                :small="false"
                @update:model-value="onChange({ name: r.nomGroupementAep, checked: $event })"
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
                :title="'Voir les ' + r.communes.length + ' communes'"
                :expanded-id="expandedId"
                @expand="expandedId = $event"
              >
                <span v-for="c of r.communes"> {{ c.code }} - {{ c.nom }}<br /> </span>
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
              :disabled="communesAssociated >= communes.length"
            />
          </li>
          <li>
            <DsfrButton
              label="Ajouter toutes les communes du département"
              secondary
              @click="createEditGroupementCommunes(null, true)"
              :disabled="zonesSelected.length > 0"
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
    @close="modalCommunesOpened = utils.closeModal(modalCommunesOpened);"
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
