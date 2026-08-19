<script setup lang="ts">
import type { Restriction } from '~/dto/restriction.dto';
import { helpers, required } from '@vuelidate/validators';
import useVuelidate from '@vuelidate/core';
import type { Commune } from '~/dto/commune.dto';
import type { ArreteCadre } from '~/dto/arrete_cadre.dto';

const props = defineProps<{
  restriction: Restriction;
  communes: Commune[];
  zonesAep: Restriction[];
  arretesCadre: ArreteCadre[];
}>();

const emit = defineEmits<{
  createEdit: any;
}>();

const initialName = props.restriction.nomGroupementAep;
const normalizeGroupName = (value?: string | null): string => (value ?? '').trim().normalize('NFKC').toLocaleLowerCase('fr-FR');
const arretesCadreOptions = props.arretesCadre.map((ac) => ({
  text: ac.numero,
  value: ac.id,
}));
const rules = computed(() => {
  return {
    nomGroupementAep: {
      required: helpers.withMessage('Le nom du groupement est obligatoire.', required),
      different: helpers.withMessage('Ce nom de groupement existe déjà, veuillez en choisir un autre.', (value: string) => {
        const initialNormalizedName = normalizeGroupName(initialName);
        const existingNames = props.zonesAep
          .map((r) => normalizeGroupName(r.nomGroupementAep))
          .filter((name) => name !== initialNormalizedName);
        return !existingNames.includes(normalizeGroupName(value));
      }),
    },
    communes: {
      required: helpers.withMessage('Le groupement de communes doit contenir au moins un code INSEE.', required),
    },
    arreteCadre: {
      required: helpers.withMessage("L'arrêté cadre associé est obligatoire.", required),
    },
  };
});
const utils = useUtils();
const hint = ref('');

const parseCommunes = (communesText: string) => {
  if (!communesText) {
    props.restriction.communes = [];
    hint.value = '';
    return;
  }
  const inseeRegex = new RegExp('(0[1-9]|[1-9][ABab\\d])\\d{3}', 'gim');
  const inseeRegexWithout0 = new RegExp('(?:\\s|^)([1-9])\\d{3}(?:\\s|$)', 'gim');
  let codesExtracted = communesText.match(inseeRegex);
  let codesExtractedWithout0 = communesText.match(inseeRegexWithout0);
  if (!codesExtracted && !codesExtractedWithout0) {
    props.restriction.communes = [];
    hint.value = 'Aucun code INSEE valide du département n’a été reconnu.';
    return;
  }
  // On récupère les séries de 4 chiffres au cas où certains mettent des codes INSEE sans le 0 devant
  codesExtracted = codesExtracted ? codesExtracted : [];
  codesExtractedWithout0 = codesExtractedWithout0 ? codesExtractedWithout0 : [];
  codesExtractedWithout0 = codesExtractedWithout0.map((c) => `0${c.trim()}`);
  codesExtracted = [...new Set([...codesExtracted, ...codesExtractedWithout0])];
  props.restriction.communes = props.communes.filter((c) => codesExtracted.includes(c.code));
  const codesNotMatch = codesExtracted.filter((c) => !props.restriction.communes?.find((co) => co.code === c)).join(', ');
  hint.value = codesNotMatch ? `Les codes suivant ne correspondent pas à des codes INSEE du département : ${codesNotMatch}.` : null;
};

const assignArreteCadre = (acId: string) => {
  props.restriction.arreteCadre = props.arretesCadre.find((ac) => ac.id === +acId);
};

const v$ = useVuelidate(rules, props.restriction, { $scope: false });

const submitForm = async () => {
  await v$.value.$validate();
  if (!v$.value.$error) {
    props.restriction.nomGroupementAep = props.restriction.nomGroupementAep.trim();
    emit('createEdit', props.restriction);
  }
};

defineExpose({
  submitForm,
});

props.restriction.communesText = props.restriction.communes?.map((c) => c.code).join('\n');
if (props.arretesCadre.length === 1 && !props.restriction.arreteCadre) {
  props.restriction.arreteCadre = props.arretesCadre[0];
}
</script>

<template>
  <form @submit.prevent="">
    <div class="fr-grid-row">
      <div class="fr-col-12">
        <h6>Informations</h6>
        <DsfrInputGroup :error-message="utils.showInputError(v$, 'nomGroupementAep')">
          <DsfrInput
            v-model="restriction.nomGroupementAep"
            data-cy="GroupementCommunesFormNomInput"
            label="Nom du groupement"
            label-visible
            required
            type="text"
          />
        </DsfrInputGroup>

        <DsfrInputGroup :error-message="utils.showInputError(v$, 'arreteCadre')">
          <DsfrSelect
            id="arrete_cadre"
            :model-value="restriction.arreteCadre?.id"
            :options="arretesCadreOptions"
            label="Arrêté cadre associé"
            label-visible
            type="text"
            name="arreteCadre"
            required
            :disabled="arretesCadre.length < 2"
            @update:model-value="assignArreteCadre($event)"
          />
        </DsfrInputGroup>

        <DsfrAlert type="info" title="Liste des codes INSEE par département" class="fr-mb-2w">
          Pour créer vos groupement de commune, vous allez devoir nous fournir les codes INSEE de chaque commune. Copier / coller à partir
          de la liste des codes correspondant à un groupement.
          <br /><a class="fr-link" href="https://www.insee.fr/fr/information/2560452" target="_blank">Liste des codes INSEE</a>
        </DsfrAlert>

        <DsfrInputGroup :error-message="utils.showInputError(v$, 'communes')">
          <DsfrInput
            :model-value="restriction.communesText"
            @update:modelValue="parseCommunes($event)"
            data-cy="GroupementCommunesFormNomInput"
            label="Coller ici votre la liste de code INSEE  correspondant aux communes de la zone."
            label-visible
            isTextarea
            required
            type="text"
          />
          <p>
            {{ props.restriction.communes?.length }} communes associées
            <br />
            {{ hint }}
          </p>
        </DsfrInputGroup>
      </div>
    </div>
  </form>
</template>
