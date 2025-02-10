<script setup lang="ts">
import { helpers, required } from '@vuelidate/validators/dist';
import useVuelidate from '@vuelidate/core';
import { requiredIf } from "@vuelidate/validators";
import type { ArreteRestriction } from "~/dto/arrete_restriction.dto";

const props = defineProps<{
  arreteRestriction: ArreteRestriction;
  warnings?: string[];
  errors?: string[];
}>();

const emit = defineEmits<{
  publier: any;
}>();
const utils = useUtils()
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const rules = computed(() => {
  return {
    dateDebut: {
      required: helpers.withMessage("La date de début de l'arrêté est obligatoire.", required),
    },
    dateFin: {
      minValue: helpers.withMessage("La date de fin de l'arrêté doit être supérieure à la date de début.", (val: string) => {
        if (props.arreteRestriction.dateDebut && val) {
          return new Date(val) >= new Date(props.arreteRestriction.dateDebut);
        }
        return true;
      }),
    },
    dateSignature: {
    },
    file: {
      required: helpers.withMessage("Le PDF de l'arrêté doit être ajouté", requiredIf(() => !props.arreteRestriction.fichier)),
      maxSize: helpers.withMessage("La taille du PDF ne doit pas dépasser 10Mo", (value: any) => {
        return !value || value?.size < MAX_FILE_SIZE
      }),
      maxLength: helpers.withMessage("Le nom du fichier ne doit pas dépasser 100 caractères. Évitez les espaces et caractères spéciaux.", (value: any) => {
        return !value || encodeURIComponent(value?.name).length <= 100
      }),
    },
  };
});

const v$ = useVuelidate(rules, props.arreteRestriction);

const submitForm = async () => {
  await v$.value.$validate();
  if (!v$.value.$error) {
    emit('publier', props.arreteRestriction);
  }
};

defineExpose({
  submitForm,
});
</script>

<template>
  <form @submit.prevent="">
    <DsfrAlert
      v-if="errors && errors.length > 0"
      type="error"
      class="fr-mb-2w">
      <div v-html="errors.join('<br/>')" />
    </DsfrAlert>
    
    <p>Choisissez la date d’entrée en vigueur de l’arrêté et sa date de fin (optionnel)</p>
    <div class="fr-grid-row fr-grid-row--gutters">
      <div class="fr-col-12 fr-col-lg-6">
        <DsfrInputGroup :error-message="utils.showInputError(v$, 'dateDebut')">
          <DsfrInput
            id="dateDebut"
            v-model="arreteRestriction.dateDebut"
            label="Date de début"
            label-visible
            type="date"
            name="dateDebut"
            data-cy="PublishFormDateDebutInput"
            :required="true"
          />
        </DsfrInputGroup>
      </div>
      <div class="fr-col-12 fr-col-lg-6">
        <DsfrInputGroup :error-message="utils.showInputError(v$, 'dateFin')">
          <DsfrInput id="dateFin"
                     v-model="arreteRestriction.dateFin"
                     label="Date de fin"
                     label-visible
                     type="date"
                     name="dateFin"
                     data-cy="PublishFormDateFinInput" />
        </DsfrInputGroup>
      </div>
      <div class="fr-col-12 fr-col-lg-6">
        <DsfrInputGroup :error-message="utils.showInputError(v$, 'dateSignature')">
          <DsfrInput id="dateSignature"
                     v-model="arreteRestriction.dateSignature"
                     label="Date de signature"
                     label-visible
                     type="date"
                     name="dateSignature"
                     data-cy="PublishFormDateSignatureInput" />
        </DsfrInputGroup>
      </div>
    </div>
    
    <div class="fr-mt-4w" v-if="arreteRestriction.fichier">
      <DsfrFileDownload
        format="PDF"
        :href="arreteRestriction.fichier.url"
        :size="utils.fileSizeString(arreteRestriction.fichier.size)"
        :download="arreteRestriction.fichier.url"
        :title="arreteRestriction.fichier.nom"
      />
    </div>

    <div class="fr-mt-4w">
      <DsfrInputGroup :error-message="utils.showInputError(v$, 'file')">
        <DsfrFileUpload :required="!arreteRestriction.fichier"
                        :label="arreteRestriction.fichier ? 'Modifier le PDF de l\'arrêté' : 'Importer le PDF de l\'arrêté'"
                        hint="Taille maximale autorisée : 10Mo. Le nom du fichier ne doit pas dépasser 100 caractères, évitez les espaces et caractères spéciaux."
                        :arreteCadrecept="['application/pdf']"
                        data-cy="PublishFormFileInput"
                        @change="arreteRestriction.file = $event[0]" />
      </DsfrInputGroup>
    </div>
  </form>
</template>
