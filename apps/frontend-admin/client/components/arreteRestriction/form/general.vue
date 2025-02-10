<script setup lang="ts">
import { helpers, required } from '@vuelidate/validators/dist';
import useVuelidate from '@vuelidate/core';
import type { ArreteRestriction } from '~/dto/arrete_restriction.dto';
import type { Ref } from 'vue';
import type { ArreteCadre } from '~/dto/arrete_cadre.dto';
import { useAuthStore } from '~/stores/auth';
import { useRefDataStore } from '~/stores/refData';
import { maxLength } from '@vuelidate/validators';

const props = defineProps<{
  arreteRestriction: ArreteRestriction;
  checkReturn: { errors: string[]; warnings: string[] };
}>();

const utils = useUtils();
const api = useApi();
const authStore = useAuthStore();
const refDataStore = useRefDataStore();
const arretesCadreTags: Ref<any> = ref([]);
const acSelected = ref();
const loading = ref(false);

const assignDepartement = (force = false) => {
  if ((!props.arreteRestriction.id && !props.arreteRestriction.departement) || force) {
    props.arreteRestriction.departement =
      authStore.user?.role === 'departement' ? refDataStore.departements.filter((d) => authStore.user?.roleDepartements.includes(d.code))[0] : null;
  }
  if (props.arreteRestriction.departement) {
    loadArretes();
  }
};

const rules = computed(() => {
  return {
    departement: {
      required: helpers.withMessage('Le département de l\'arrêté est obligatoire', required),
    },
    numero: {
      required: helpers.withMessage('Le numéro de l\'arrêté est obligatoire', required),
      maxLength: helpers.withMessage('Le numéro de l\'arrêté ne doit pas dépasser 50 caractères.', maxLength(50)),
    },
    arretesCadre: {
      required: helpers.withMessage('L\'arrêté doit être lié à au moins un arrêté cadre', required),
    },
    arreteRestrictionAbroge: {},
  };
});

const v$ = useVuelidate(rules, props.arreteRestriction);

const arretesCadreFiltered: Ref<any> = ref([]);
const arretesCadre: Ref<any> = ref([]);

const loadArretes = async () => {
  const query = `depCode=${props.arreteRestriction.departement.code}`;
  loading.value = true;
  const { data, error } = await api.arreteCadre.list(query);
  if (data.value) {
    arretesCadre.value = data.value;
    filterArretesCadre();
    computeArretesCadreTags();
  }
  loading.value = false;
};

const filterArretesCadre = () => {
  arretesCadreFiltered.value = arretesCadre.value
    .filter((ac: ArreteCadre) => {
      return !props.arreteRestriction.arretesCadre.map((arAc) => arAc.id).includes(ac.id);
    })
    .map((ac: ArreteCadre) => {
      return {
        value: ac.id,
        text: ac.numero,
      };
    });
  if (arretesCadreFiltered.value.length < 1) {
    arretesCadreFiltered.value = [
      {
        value: null,
        text: 'Aucun arrêté cadre en vigueur disponible',
        disabled: true,
      },
    ];
  }
};

const selectArreteCadre = (acId: string) => {
  const ac = arretesCadre.value.find((ac: ArreteCadre) => ac.id === +acId);
  props.arreteRestriction.arretesCadre = [...props.arreteRestriction.arretesCadre, ac];
  computeArretesCadreTags();
  filterArretesCadre();
  setTimeout(() => {
    acSelected.value = null;
  });
};

const deleteArreteCadre = (acId: number) => {
  props.arreteRestriction.arretesCadre = props.arreteRestriction.arretesCadre.filter((ac) => ac.id !== acId);
  computeArretesCadreTags();
  filterArretesCadre();
};

const computeArretesCadreTags = () => {
  arretesCadreTags.value = props.arreteRestriction.arretesCadre.map((ac) => {
    return {
      label: ac.numero,
      class: 'fr-tag--dismiss',
      tagName: 'button',
      onclick: () => {
        deleteArreteCadre(ac.id);
      },
    };
  });
};

const departementChange = (depId: string) => {
  const departement = refDataStore.departements.find((d) => d.id === Number(depId));
  props.arreteRestriction.departement = departement;
  props.arreteRestriction.arretesCadre = [];
  loadArretes();
};

const departementsOptions = refDataStore.departements
  .filter(d => authStore.user?.role === 'mte' || authStore.user?.roleDepartements.includes(d.code))
  .map((d) => {
    return {
      value: d.id,
      text: `${d.code} - ${d.nom}`,
    };
  });

defineExpose({
  v$,
});

watch(
  () => refDataStore.departements,
  () => {
    if (refDataStore.departements && refDataStore.departements.length > 0) {
      assignDepartement();
    }
  },
  { immediate: true },
);
</script>

<template>
  <form @submit.prevent="">
    <div class="fr-grid-row">
      <div class="fr-col-12 fr-col-lg-6">
        <h6>Généralité</h6>
        <DsfrInputGroup
          v-if="arreteRestriction.arreteRestrictionAbroge"
          :error-message="utils.showInputError(v$, 'arreteRestrictionAbroge')"
        >
          <DsfrInput
            disabled
            :model-value="arreteRestriction.arreteRestrictionAbroge?.numero"
            data-cy="ArreteRestrictionFormAbrogeInput"
            label="Arrêté abrogé"
            label-visible
            type="text"
          />
        </DsfrInputGroup>

        <DsfrInputGroup :error-message="utils.showInputError(v$, 'numero')">
          <DsfrInput
            id="numero"
            v-model="arreteRestriction.numero"
            data-cy="ArreteRestrictionFormNumeroInput"
            label="Numéro de l'arrêté"
            label-visible
            type="text"
            name="numero"
            :required="true"
          />
          <span class="fr-input-group__sub-hint">{{ arreteRestriction.numero ? arreteRestriction.numero.length : 0 }}/50</span>
        </DsfrInputGroup>

        <DsfrHighlight
          v-if="authStore.user?.role !== 'mte' && arreteRestriction.departement?.id && authStore.user?.roleDepartements.length <= 1"
          :text="arreteRestriction.departement.nom"
        />

        <DsfrInputGroup :error-message="utils.showInputError(v$, 'departement')">
          <DsfrSelect
            v-if="authStore.user?.role === 'mte' || authStore.user?.roleDepartements.length > 1"
            :model-value="arreteRestriction.departement?.id"
            label="Département"
            :options="departementsOptions"
            @update:modelValue="departementChange($event)"
          />
        </DsfrInputGroup>

        <DsfrInputGroup :error-message="utils.showInputError(v$, 'arretesCadre')">
          <DsfrSelect
            :disabled="!arreteRestriction.departement || loading"
            data-cy="ArreteRestrictionFormAcSelect"
            :labelVisible="true"
            :options="arretesCadreFiltered"
            placeholder="Rechercher un arrêté cadre"
            v-model="acSelected"
            required
            @update:modelValue="selectArreteCadre($event)"
          >
            <template #label>
              Ajouter un/des arrêtés cadre
              <VIcon v-if="loading" name="ri-loader-4-line" animation="spin" />
            </template>
          </DsfrSelect>

          <DsfrTags class="fr-mt-2w" :tags="arretesCadreTags" />
        </DsfrInputGroup>
      </div>
      <div class="fr-col-12 fr-col-lg-6"></div>

      <ArreteRestrictionFormPublier v-if="arreteRestriction.statut !== 'a_valider'"
                                    :arreteRestriction="arreteRestriction"
                                    :warnings="checkReturn?.warnings"
                                    :errors="checkReturn?.errors" />
    </div>
  </form>
</template>
