<script setup lang="ts">
import { ArreteCadre } from '~/dto/arrete_cadre.dto';
import { helpers, required } from '@vuelidate/validators/dist';
import useVuelidate from '@vuelidate/core';
import type { Ref } from 'vue';
import type { Departement } from '~/dto/departement.dto';
import { useAuthStore } from '~/stores/auth';
import { useRefDataStore } from '~/stores/refData';
import deburr from 'lodash.deburr';
import { maxLength, requiredIf } from '@vuelidate/validators';
import type { ArreteRestriction } from '~/dto/arrete_restriction.dto';

const props = defineProps<{
  arreteCadre: ArreteCadre;
}>();

const query: Ref<string> = ref('');
const departementsTags: Ref<any> = ref([]);
const departementsFiltered: Ref<any> = ref([]);
const utils = useUtils();
const authStore = useAuthStore();
const refDataStore = useRefDataStore();
const isAci: Ref<boolean> = ref(props.arreteCadre.departements.length > 1);

const assignDepartement = (force = false) => {
  if (!props.arreteCadre.id || force) {
    if (props.arreteCadre.departements.length < 1) {
      props.arreteCadre.departements = authStore.user.role === 'departement' ?
        [refDataStore.departements.find((d) => authStore.user.roleDepartements.includes(d.code))] : [];
    } else if (props.arreteCadre.departements.length > 1 && !isAci.value) {
      props.arreteCadre.departements = [props.arreteCadre.departements[0]];
    }
    computeDepartementsTags();
  }
};

const rules = computed(() => {
  return {
    numero: {
      required: helpers.withMessage('Le numéro de l\'arrêté est obligatoire', required),
      maxLength: helpers.withMessage('Le numéro de l\'arrêté ne doit pas dépasser 50 caractères.', maxLength(50)),
    },
    departements: {
      required: helpers.withMessage('L\'arrêté doit être lié à au moins un département', required),
    },
    arreteCadreAbroge: {},
  };
});

const filterDepartements = () => {
  let tmp = refDataStore.departements
    .filter((d) => !props.arreteCadre.departements.map((ad) => ad.id).includes(d.id));
  if (query.value) {
    tmp = tmp.filter((d) => {
      return (deburr(d.nom)
          .replace(/[\s\-\_]/g, '')
          .toLowerCase()
          .includes(
            deburr(query.value)
              .replace(/[\s\-\_]/g, '')
              .toLowerCase(),
          ) ||
        d.code.toLowerCase().includes(query.value.toLowerCase())
      );
    });
  }
  tmp.map((d: any) => {
    d.display = `${d.code} - ${d.nom}`;
    return d;
  });
  departementsFiltered.value = tmp;
};

const departementsOptions = refDataStore.departements
  .filter(d => authStore.user?.role === 'mte' || authStore.user?.roleDepartements.includes(d.code))
  .map((d) => {
    return {
      value: d.id,
      text: `${d.code} - ${d.nom}`,
    };
  });

const selectDepartement = (departement: Departement) => {
  if (typeof departement === 'string') {
    return;
  }
  query.value = '';
  props.arreteCadre.departements = [...props.arreteCadre.departements, departement];
  computeDepartementsTags();
  filterDepartements();
};

const deleteDepartement = (departementId: number) => {
  props.arreteCadre.departements = props.arreteCadre.departements.filter((d) => d.id !== departementId);
  computeDepartementsTags();
  filterDepartements();
};

const computeDepartementsTags = () => {
  departementsTags.value = props.arreteCadre.departements.map((d) => {
    return {
      label: `${d.code} - ${d.nom}`,
      class: d.code === props.arreteCadre.departements[0]?.code ? '' : 'fr-tag--dismiss',
      tagName: 'button',
      onclick: () => {
        if (d.code === props.arreteCadre.departements[0]?.code) {
          return;
        }
        deleteDepartement(d.id);
      },
    };
  });
};

const departementPiloteChange = (depPiloteId: string) => {
  const departementPilote = refDataStore.departements.find((d) => d.id === Number(depPiloteId));
  // On remplace le département pilote s'il existe
  const deps = props.arreteCadre.departements.filter((d) => d.id !== Number(depPiloteId));
  props.arreteCadre.departements = [...[departementPilote], ...deps];
  computeDepartementsTags();
};

computeDepartementsTags();

const isDepPilote = computed(() => {
  return authStore.user?.role === 'mte' || authStore.user?.roleDepartements.includes(props.arreteCadre.departements[0]?.code);
});

const v$ = useVuelidate(rules, props.arreteCadre);

const aciOptions = [
  {
    label: 'Interdépartemental',
    value: true,
  },
  {
    label: 'Départemental',
    value: false,
  },
];

watch(
  query,
  useUtils().debounce(async () => {
    filterDepartements();
  }, 300),
  { immediate: true },
);

watch(isAci, () => {
  assignDepartement(true);
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

defineExpose({
  v$,
});
</script>

<template>
  <form @submit.prevent="">
    <div class="fr-grid-row">
      <div class="fr-col-12 fr-col-lg-6">
        <h6>Généralité</h6>
        <DsfrInputGroup
          v-if="arreteCadre.arreteCadreAbroge"
          :error-message="utils.showInputError(v$, 'arreteCadreAbroge')">
          <DsfrInput
            disabled
            :model-value="arreteCadre.arreteCadreAbroge?.numero"
            data-cy="ArreteCadreFormAbrogeInput"
            label="Arrêté abrogé"
            label-visible
            type="text"
          />
        </DsfrInputGroup>

        <DsfrInputGroup :error-message="utils.showInputError(v$, 'numero')">
          <DsfrInput
            id="numero"
            v-model="arreteCadre.numero"
            data-cy="ArreteCadreFormNumeroInput"
            label="Numéro de l'arrêté"
            label-visible
            type="text"
            name="numero"
            :required="true"
          />
          <span class="fr-input-group__sub-hint">{{ arreteCadre.numero ? arreteCadre.numero.length : 0 }}/50</span>
        </DsfrInputGroup>

        <DsfrRadioButtonSet legend="Cet arrêté est :" :options="aciOptions" v-model="isAci" name="isAci" :small="false" />
        <DsfrHighlight
          v-if="authStore.user?.role !== 'mte' && !isAci && arreteCadre.departements[0] && authStore.user?.roleDepartements.length <= 1"
          :text="arreteCadre.departements[0].nom"
        />
        <DsfrInputGroup :error-message="utils.showInputError(v$, 'departements')">
          <DsfrSelect
            v-if="authStore.user?.role === 'mte' || authStore.user?.roleDepartements.length > 1 || isAci"
            :model-value="arreteCadre.departements[0]?.id"
            :label="isAci ? 'Département pilote' : 'Département'"
            :options="departementsOptions"
            @update:modelValue="departementPiloteChange($event)"
          />
        </DsfrInputGroup>
        <DsfrAlert
          v-if="isAci && isDepPilote"
          type="info"
          title="Arrêté Interdépartemental"
          description="En tant que DDT pilote, vous avez la responsabilité de remplir les usages et mesures qui serviront à tous les départements. Les autres départements devront uniquement sélectionner leurs zones d’alerte concernées par cet arrêté cadre."
          class="fr-mb-2w"
        />

        <div class="fr-mt-2w" v-if="isAci">
          <DsfrInputGroup :error-message="utils.showInputError(v$, 'departements')">
            <MixinsAutoComplete
              label="Ajouter un/des départements"
              data-cy="ArreteCadreFormDepartementsAutocomplete"
              class="show-label"
              icon="ri-add-fill"
              :labelVisible="true"
              buttonText="Ajouter"
              display-key="display"
              v-model="query"
              :options="departementsFiltered"
              placeholder="Rechercher un département"
              @update:modelValue="selectDepartement($event)"
              @search="selectDepartement($event)"
            />

            <DsfrTags class="fr-mt-2w" :tags="departementsTags" />
          </DsfrInputGroup>

          <DsfrAlert
            v-if="isDepPilote"
            type="info"
            title="Email d'information"
            description="Afin de favoriser une bonne communication, un email sera envoyé aux départements dont les zones d'alerte sont vides afin qu’ils remplissent leurs zones d’alerte dans les meilleurs délais."
            class="fr-mb-2w"
          />
        </div>

        <ArreteCadreFormPublier :showDateFin="true" v-if="arreteCadre.statut !== 'a_valider'" :arrete-cadre="arreteCadre" />
      </div>
    </div>
  </form>
</template>
