<script setup lang="ts">
import { helpers, required } from '@vuelidate/validators/dist';
import useVuelidate from '@vuelidate/core';
import { ArreteCadre, ArreteCadreStatutFr } from "~/dto/arrete_cadre.dto";

const props = defineProps<{
  arreteCadre: ArreteCadre;
}>();

const emit = defineEmits<{
  abroger: any;
}>();
const utils = useUtils()
const ac = ref({...props.arreteCadre});

const rules = computed(() => {
  return {
    dateFin: {
      required: helpers.withMessage("La date de fin de l'arrêté est obligatoire.", required),
      minValue: helpers.withMessage("La date de fin de l'arrêté doit être supérieure à la date de début.", (val: string) => {
        if (ac.value.dateDebut && val) {
          return new Date(val) >= new Date(ac.value.dateDebut);
        }
        return true;
      }),
    },
  };
});

const v$ = useVuelidate(rules, ac);

const submitForm = async () => {
  await v$.value.$validate();
  if (!v$.value.$error) {
    emit('abroger', ac.value);
  }
};

const arEnVigueur = computed(() => {
  return props.arreteCadre.arretesRestriction?.filter((ar) => ['a_venir', 'publie'].includes(ar.statut));
});
const arreteCadreStatutFr = ArreteCadreStatutFr;

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
            :model-value="ac.dateDebut"
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
            v-model="ac.dateFin"
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
    <p v-if="arEnVigueur.length > 0" class="fr-mt-4w">
      Les arrêtés de restriction suivant seront abrogés :
      <template v-for="ar of arEnVigueur">
        <br/>- {{ ar.numero }} - {{ arreteCadreStatutFr[ar.statut] }}
      </template>
    </p>
  </form>
</template>
