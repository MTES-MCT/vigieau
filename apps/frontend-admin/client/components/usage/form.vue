<script setup lang="ts">
import useVuelidate from '@vuelidate/core/dist';
import { maxLength, required } from '@vuelidate/validators/dist';
import { Usage } from '~/dto/usage.dto';
import { useRefDataStore } from '~/stores/refData';
import { helpers, or } from '@vuelidate/validators';
import { ThematiqueExamples } from '~/dto/thematique.dto';

const props = defineProps<{
  usage: Usage;
  loading: boolean;
}>();

const emit = defineEmits<{
  createEdit: any;
}>();

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
    name: 'ESO',
  },
  {
    attribute: 'concerneEsu',
    name: 'ESU',
  },
  {
    attribute: 'concerneAep',
    name: 'AEP',
  },
];

const rules = computed(() => {
  return {
    nom: {
      required: helpers.withMessage('Le nom est obligatoire.', required),
      maxLength: helpers.withMessage('Le nom ne doit pas dépasser 150 caractères.', maxLength(150)),
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
      shouldBeChecked: helpers.withMessage("Au moins un type d'usager doit être renseigné.", () => {
        return (
          props.usage.concerneParticulier ||
          props.usage.concerneEntreprise ||
          props.usage.concerneCollectivite ||
          props.usage.concerneExploitation
        );
      }),
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
  props.usage.thematique = refDataStore.thematiques.findLast((t) => t.id == $event);
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
  <DsfrInputGroup :error-message="utils.showInputError(v$, 'nom')">
    <DsfrInput
      id="nom"
      v-model="usage.nom"
      label="Nom de l'usage"
      label-visible
      type="text"
      data-cy="UsageFormNameInput"
      name="nom"
      :required="true"
    />
    <span class="fr-input-group__sub-hint">{{ usage.nom ? usage.nom.length : 0 }}/150</span>
  </DsfrInputGroup>
  <DsfrInputGroup :error-message="utils.showInputError(v$, 'thematique')">
    <DsfrSelect
      :required="true"
      label="Choisir une thématique pour l'affichage dans VigiEau"
      data-cy="UsageFormThematiqueSelect"
      :options="thematiquesOptions"
      :value="usage.thematique?.id"
      @update:modelValue="thematiqueSelected"
    />
  </DsfrInputGroup>
  <DsfrAlert v-if="usage.thematique" type="warning" title="Vérifier la thématique" class="fr-mb-2w">
    <div v-html="thematiqueDescription" />
  </DsfrAlert>

  <div class="fr-my-2w">Usagers</div>
  <DsfrInputGroup :error-message="utils.showInputError(v$, 'concerne')">
    <DsfrInputGroup v-for="concerne of concernes" :error-message="utils.showInputError(v$, concerne.attribute)">
      <DsfrCheckbox
        :label="concerne.name"
        :name="concerne.attribute"
        :data-cy="'UsageForm' + concerne.attribute + 'Checkbox'"
        v-model="usage[concerne.attribute]"
      />
    </DsfrInputGroup>
  </DsfrInputGroup>

  <div class="fr-my-2w">À quelle(s) ressource(s) cet usage est-il associé ?</div>
  <DsfrInputGroup :error-message="utils.showInputError(v$, 'ressource')">
    <DsfrInputGroup v-for="ressource of resssources" :error-message="utils.showInputError(v$, ressource.attribute)">
      <DsfrCheckbox
        :label="ressource.name"
        :name="ressource.attribute"
        :data-cy="'UsageForm' + ressource.attribute + 'Checkbox'"
        v-model="usage[ressource.attribute]"
      />
    </DsfrInputGroup>
  </DsfrInputGroup>
</template>
