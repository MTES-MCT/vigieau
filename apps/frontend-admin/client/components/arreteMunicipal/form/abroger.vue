<script setup lang="ts">
import { helpers, required } from '@vuelidate/validators/dist';
import useVuelidate from '@vuelidate/core';
import type { ArreteMunicipal } from '~/dto/arrete_municipal.dto';

const props = defineProps<{
  arreteMunicipal: ArreteMunicipal;
}>();

const emit = defineEmits<{
  abroger: any;
}>();
const utils = useUtils()
const am = ref({...props.arreteMunicipal});

const rules = computed(() => {
  return {
    dateFin: {
      required: helpers.withMessage("La date de fin de l'arrêté est obligatoire.", required),
      minValue: helpers.withMessage("La date de fin de l'arrêté doit être supérieure à la date de début.", (val: string) => {
        if (am.value.dateDebut && val) {
          return new Date(val) >= new Date(am.value.dateDebut);
        }
        return true;
      }),
    },
  };
});

const v$ = useVuelidate(rules, am);

const submitForm = async () => {
  await v$.value.$validate();
  if (!v$.value.$error) {
    emit('abroger', am.value);
  }
};

defineExpose({
  submitForm,
});
</script>

<template>
  <form @submit.prevent="">
    <p>Choisissez la date de fin de l’arrêté</p>
    <div class="fr-grid-row fr-grid-row--gutters">
      <div class="fr-col-12 fr-col-lg-6">
        <DsfrInputGroup :error-message="utils.showInputError(v$, 'dateDebut')">
          <DsfrInput
            id="dateDebut"
            :model-value="am.dateDebut"
            label="Date de début de l'arrêté"
            label-visible
            type="date"
            name="dateDebut"
            data-cy="RepealFormDateDebutInput"
            :disabled="true"
          />
        </DsfrInputGroup>
      </div>
      <div class="fr-col-12 fr-col-lg-6">
        <DsfrInputGroup :error-message="utils.showInputError(v$, 'dateFin')">
          <DsfrInput
            id="dateFin"
            v-model="am.dateFin"
            label="Date de fin de l'arrêté"
            label-visible
            type="date"
            name="dateFin"
            data-cy="RepealFormDateFinInput"
            :required="true"
          />
        </DsfrInputGroup>
      </div>
    </div>
  </form>
</template>
