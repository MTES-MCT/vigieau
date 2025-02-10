<script setup lang="ts">
import { helpers, required } from '@vuelidate/validators';
import useVuelidate from '@vuelidate/core';
import type { Commune } from '~/dto/commune.dto';
import type { ZoneAlerte } from '~/dto/zone_alerte.dto';

const props = defineProps<{
  zoneAlerte: ZoneAlerte;
  communes: Commune[];
}>();

const emit = defineEmits<{
  createEdit: any;
}>();

const rules = computed(() => {
  return {
    communes: {
      required: helpers.withMessage('Le groupement de communes doit contenir au moins un code INSEE.', required),
    },
  };
});
const utils = useUtils();
const hint = ref('');

const parseCommunes = (communesText: string) => {
  if (!communesText) {
    return;
  }
  const inseeRegex = new RegExp('(0[1-9]|[1-9][ABab\\d])\\d{3}', 'gim');
  const inseeRegexWithout0 = new RegExp('(?:\\s|^)([1-9])\\d{3}(?:\\s|$)', 'gim');
  let codesExtracted = communesText.match(inseeRegex);
  let codesExtractedWithout0 = communesText.match(inseeRegexWithout0);
  if (!codesExtracted && !codesExtractedWithout0) {
    return;
  }
  // On récupère les séries de 4 chiffres au cas où certains mettent des codes INSEE sans le 0 devant
  codesExtracted = codesExtracted ? codesExtracted : [];
  codesExtractedWithout0 = codesExtractedWithout0 ? codesExtractedWithout0 : [];
  codesExtractedWithout0 = codesExtractedWithout0.map((c) => `0${c.trim()}`);
  codesExtracted = [...new Set([...codesExtracted, ...codesExtractedWithout0])];
  props.zoneAlerte.communes = props.communes.filter((c) => codesExtracted.includes(c.code));
  const codesNotMatch = codesExtracted.filter((c) => !props.zoneAlerte.communes?.find((co) => co.code === c)).join(', ');
  hint.value = codesNotMatch ? `Les codes suivant ne correspondent pas à des codes INSEE du département : ${codesNotMatch}.` : null;
};

const v$ = useVuelidate(rules, props.zoneAlerte, { $scope: false });

const submitForm = async () => {
  await v$.value.$validate();
  if (!v$.value.$error) {
    emit('createEdit', props.zoneAlerte);
  }
};

defineExpose({
  submitForm,
});

props.zoneAlerte.communesText = props.zoneAlerte.communes?.map((c) => c.code).join('\n');
</script>

<template>
  <form @submit.prevent="">
    <div class="fr-grid-row fr-grid-row--gutters">
      <div class="fr-col-6">
        <DsfrAlert
          type="info"
          title="Liste des codes INSEE par département"
          class="fr-mb-2w">
          Pour créer vos groupement de commune, vous allez devoir nous fournir les codes INSEE de chaque commune. Copier / coller à partir
          de la liste des codes correspondant à un groupement.
          <br /><a class="fr-link" href="https://www.insee.fr/fr/information/2560452" target="_blank">Liste des codes INSEE</a>
        </DsfrAlert>

        <DsfrInputGroup :error-message="utils.showInputError(v$, 'communes')">
          <DsfrInput
            :model-value="zoneAlerte.communesText"
            @update:modelValue="parseCommunes($event)"
            data-cy="GroupementCommunesFormNomInput"
            label="Coller ici votre la liste de code INSEE  correspondant aux communes de la zone."
            label-visible
            isTextarea
            required
            type="text"
            rows="5"
          />
          <p>
            {{ props.zoneAlerte.communes?.length }} communes associées
            <br />
            {{ hint }}
          </p>
        </DsfrInputGroup>
      </div>
      <div class="fr-col-6">
        <ArreteCadreCarteCommune :communes="zoneAlerte.communes" :departement="zoneAlerte.departement" />
      </div>
    </div>
  </form>
</template>
