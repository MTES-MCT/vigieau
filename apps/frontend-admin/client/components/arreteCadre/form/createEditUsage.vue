<script setup lang="ts">

import { useRefDataStore } from '~/stores/refData';
import { helpers, maxLength, required } from '@vuelidate/validators';
import useVuelidate from '@vuelidate/core';
import { ThematiqueExamples } from '~/dto/thematique.dto';
import type { Usage } from '~/dto/usage.dto';

const props = defineProps<{
  usage: Usage;
  otherUsages: Usage[];
  disableUsageName: boolean;
  loading: boolean;
}>();

const emit = defineEmits<{
  createEdit: any;
}>();

const initialName = props.usage.nom;

const utils = useUtils();
const refDataStore = useRefDataStore();
const thematiquesOptions = refDataStore.thematiques.map((t) => {
  return {
    value: t.id,
    text: t.nom,
  };
});

const concernes = [
  {
    attribute: 'concerneParticulier',
    name: 'Particulier',
  },
  {
    attribute: 'concerneEntreprise',
    name: 'Entreprise',
  },
  {
    attribute: 'concerneCollectivite',
    name: 'Collectivité',
  },
  {
    attribute: 'concerneExploitation',
    name: 'Exploitant agricole',
  },
];

const resssources = [
  {
    attribute: 'concerneEso',
    name: 'ESO (Eaux souterraines)',
  },
  {
    attribute: 'concerneEsu',
    name: 'ESU (Eaux superficielles)',
  },
  {
    attribute: 'concerneAep',
    name: 'AEP (Eau potable)',
  },
];

const niveauxRestriction = [
  {
    attribute: 'descriptionVigilance',
    name: 'Vigilance',
    badgeType: 'info',
    required: false,
  },
  {
    attribute: 'descriptionAlerte',
    name: 'Alerte',
    badgeType: 'new',
    required: false,
  },
  {
    attribute: 'descriptionAlerteRenforcee',
    name: 'Alerte renforcée',
    badgeType: 'warning',
    required: false,
  },
  {
    attribute: 'descriptionCrise',
    name: 'Crise',
    badgeType: 'error',
    required: true,
  },
];

const rules = computed(() => {
  return {
    nom: {
      required: helpers.withMessage('Le nom est obligatoire.', required),
      maxLength: helpers.withMessage('Le nom ne doit pas dépasser 150 caractères.', maxLength(150)),
      different: helpers.withMessage('Ce nom d\'usage existe déjà, veuillez en choisir un autre.', (value: string) => {
        const existingNames = props.otherUsages.map((u) => u.nom).filter((n) => n !== initialName);
        return !existingNames.includes(value);
      }),
    },
    thematique: { required: helpers.withMessage('La thématique est obligatoire.', required) },
    concerneParticulier: { required },
    concerneEntreprise: { required },
    concerneCollectivite: { required },
    concerneExploitation: { required },
    concerneEso: { required },
    concerneEsu: { required },
    concerneAep: { required },
    ressource: {
      shouldBeChecked: helpers.withMessage('Au moins un type de ressource doit être renseigné.', () => {
        return props.usage.concerneEso || props.usage.concerneEsu || props.usage.concerneAep;
      }),
    },
    concerne: {
      shouldBeChecked: helpers.withMessage('Au moins un type d\'usager doit être renseigné.', () => {
        return (
          props.usage.concerneParticulier ||
          props.usage.concerneEntreprise ||
          props.usage.concerneCollectivite ||
          props.usage.concerneExploitation
        );
      }),
    },
    descriptionVigilance: {
      maxLength: helpers.withMessage('La description ne doit pas dépasser 500 caractères.', maxLength(500)),
    },
    descriptionAlerte: {
      maxLength: helpers.withMessage('La description ne doit pas dépasser 500 caractères.', maxLength(500)),
    },
    descriptionAlerteRenforcee: {
      maxLength: helpers.withMessage('La description ne doit pas dépasser 500 caractères.', maxLength(500)),
    },
    descriptionCrise: {
      required: helpers.withMessage('Au moins une mesure en cas de crise est obligatoire.', required),
      maxLength: helpers.withMessage('La description ne doit pas dépasser 500 caractères.', maxLength(500)),
    },
  };
});

const v$ = useVuelidate(rules, props.usage, { $scope: false });

const submitForm = async () => {
  await v$.value.$validate();
  if (!v$.value.$error && !props.loading) {
    emit('createEdit', props.usage);
  }
};

const thematiqueSelected = ($event: number) => {
  props.usage.thematique = refDataStore.thematiques.find((t) => t.id == $event);
};

const thematiqueDescription = computed(() => {
  return `Pour éviter les incompréhensions des usagers de VigiEau, vérifiez que la thématique choisie est bien cohérente avec l’usage. Par exemple ${props
    .usage.thematique?.nom} peut être associé avec&nbsp;: ${ThematiqueExamples[props.usage.thematique?.nom]}.`;
});

defineExpose({
  submitForm,
  v$,
});
</script>

<template>
  <form @submit.prevent="">
    <DsfrInputGroup :error-message="utils.showInputError(v$, 'nom')">
      <DsfrInput
        id="usage_nom"
        v-model="usage.nom"
        label="Nom de l'usage"
        label-visible
        type="text"
        data-cy="UsageFormNameInput"
        name="usage_nom"
        :required="true"
        ref="usageFormNameInput"
        :disabled="disableUsageName"
      />
      <span class="fr-input-group__sub-hint">{{ usage.nom ? usage.nom.length : 0 }}/150</span>
    </DsfrInputGroup>

    <DsfrInputGroup :error-message="utils.showInputError(v$, 'thematique')">
      <DsfrSelect
        :required="true"
        label="Choisir une thématique pour l'affichage dans VigiEau"
        data-cy="UsageFormThematiqueSelect"
        :options="thematiquesOptions"
        :model-value="usage.thematique?.id"
        @update:modelValue="thematiqueSelected"
      />
    </DsfrInputGroup>
    <DsfrAlert v-if="usage.thematique" type="warning" title="Vérifier la thématique" class="fr-mb-2w">
      <div v-html="thematiqueDescription" />
    </DsfrAlert>

    <div class="fr-my-2w">Usagers</div>
    <DsfrInputGroup :error-message="utils.showInputError(v$, 'concerne')">
      <DsfrCheckbox
        v-for="concerne of concernes"
        :label="concerne.name"
        :name="concerne.attribute"
        :data-cy="'UsageForm' + concerne.attribute + 'Checkbox'"
        v-model="usage[concerne.attribute]"
      />
    </DsfrInputGroup>

    <div class="fr-my-2w">À quelle(s) ressource(s) cet usage est-il associé ?</div>
    <DsfrInputGroup :error-message="utils.showInputError(v$, 'ressource')">
      <DsfrCheckbox
        v-for="ressource of resssources"
        :label="ressource.name"
        :name="ressource.attribute"
        :data-cy="'UsageForm' + ressource.attribute + 'Checkbox'"
        v-model="usage[ressource.attribute]"
      />
    </DsfrInputGroup>

    <div class="fr-my-2w divider" />
    <h6>Niveau de restriction</h6>
    <DsfrAlert type="warning" title="Rédaction des mesures" class="fr-mb-2w">
      Pour permettre aux usagers de VigiEau une bonne compréhension des mesures&nbsp;:
      <b>
        <br />-&nbsp;éviter les acronymes <br />-&nbsp;simplifier au maximum les tournures de phrases <br />-&nbsp;ajouter “voir
        exceptions
        listées dans l’arrêté préfectoral” lorsque le texte est trop long
      </b>
    </DsfrAlert>
    <template v-for="(niveau, index) of niveauxRestriction">
      <div v-if="index !== 0" class="fr-mb-2w divider" />
      <DsfrBadge :label="niveau.name" :type="niveau.badgeType" />
      <DsfrInputGroup :error-message="utils.showInputError(v$, niveau.attribute)">
        <DsfrInput
          :id="niveau.attribute"
          v-model="usage[niveau.attribute]"
          :is-textarea="true"
          label="Ajouter un texte libre"
          label-visible
          type="text"
          rows="4"
          :data-cy="'UsageArreteCadreForm' + niveau.attribute + 'Input'"
          :name="niveau.attribute"
          :required="niveau.required"
        />
        <span class="fr-input-group__sub-hint">
          {{ usage[niveau.attribute] ? usage[niveau.attribute].length : 0 }}/500
        </span>
      </DsfrInputGroup>
    </template>
  </form>
</template>