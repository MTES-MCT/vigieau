<script setup lang="ts">
import { fileAccessUrl } from '~/utils/audit';
import type { ArreteMunicipal } from '~/dto/arrete_municipal.dto';
import { email, helpers, required, requiredIf } from '@vuelidate/validators';
import useVuelidate from '@vuelidate/core';
import type { Ref } from 'vue';
import { useAuthStore } from '~/stores/auth';
import { useRefDataStore } from '~/stores/refData';

const props = defineProps<{
  arreteMunicipal: ArreteMunicipal;
}>();

const utils = useUtils();
const authStore = useAuthStore();
const refDataStore = useRefDataStore();
const hint = ref('');
const communes: Ref<any> = ref([]);
const communesLoading = ref(false);
const communesText = ref(props.arreteMunicipal.communes?.map((c) => c.code).join('\n'));
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const rules = computed(() => {
  return {
    userFirstName: {
      required: helpers.withMessage("L'utilisateur est obligatoire.", required),
    },
    userEmail: {
      required: helpers.withMessage("L'email est obligatoire.", required),
      email: helpers.withMessage("L'email n'est pas valide.", email),
    },
    userPhone: {
      required: helpers.withMessage('Le numéro de téléphone est obligatoire.', required),
      phone: helpers.withMessage("Le numéro de téléphone n'est pas valide.", utils.phoneValidator),
    },
    communes: {
      required: helpers.withMessage("L'arrêté doit concerner au moins un code INSEE.", required),
    },
    dateDebut: {
      required: helpers.withMessage("La date de début de l'arrêté est obligatoire", required),
    },
    dateFin: {
      required: helpers.withMessage("La date de fin de l'arrêté est obligatoire", required),
      minValue: helpers.withMessage("La date de fin de l'arrêté doit être supérieure à la date de début.", (val: string) => {
        if (props.arreteMunicipal.dateDebut && val) {
          return new Date(val) >= new Date(props.arreteMunicipal.dateDebut);
        }
        return true;
      }),
    },
    file: {
      required: helpers.withMessage(
        "Le PDF de l'arrêté doit être ajouté",
        requiredIf(() => !props.arreteMunicipal.fichier),
      ),
      maxSize: helpers.withMessage('La taille du PDF ne doit pas dépasser 10Mo', (value: any) => {
        return !value || value?.size < MAX_FILE_SIZE;
      }),
      maxLength: helpers.withMessage(
        'Le nom du fichier ne doit pas dépasser 100 caractères. Évitez les espaces et caractères spéciaux.',
        (value: any) => {
          return !value || encodeURIComponent(value?.name).length <= 100;
        },
      ),
    },
  };
});

const userFullName = computed(() => {
  return `${props.arreteMunicipal.userFirstName} ${props.arreteMunicipal.userLastName}`;
});

const v$ = useVuelidate(rules, props.arreteMunicipal);

const loadCommunes = async () => {
  communesLoading.value = true;
  try {
    await refDataStore.ensureCommunesLoaded();
    communes.value = refDataStore.communes;
    if (!props.arreteMunicipal.id && authStore.user?.role === 'commune') {
      props.arreteMunicipal.communes = communes.value.filter((c: any) => authStore.user?.roleCommunes.includes(c.code));
      communesText.value = props.arreteMunicipal.communes?.map((c) => c.code).join('\n');
    }
  } finally {
    communesLoading.value = false;
  }
};

const parseCommunes = (communesText: string) => {
  if (!communesText) {
    return;
  }
  const inseeRegex = /(0[1-9]|[1-9][AB\d])\d{3}/gi;
  const inseeRegexWithout0 = /(?:\s|^)([1-9])\d{3}(?:\s|$)/gm;
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
  props.arreteMunicipal.communes = communes.value.filter((c) => codesExtracted.includes(c.code));
  const codesNotMatch = codesExtracted.filter((c) => !props.arreteMunicipal.communes?.find((co) => co.code === c)).join(', ');
  hint.value = codesNotMatch ? `Vous n'avez pas les droits pour ajouter ces communes : ${codesNotMatch}.` : null;
};

loadCommunes();

defineExpose({
  v$,
});
</script>

<template>
  <form @submit.prevent="">
    <div class="fr-grid-row fr-mt-2w">
      <div class="fr-col-12 fr-col-lg-6">
        <DsfrInputGroup :error-message="utils.showInputError(v$, 'userFirstName')">
          <DsfrInput
            id="user"
            v-model="userFullName"
            data-cy="FormUserInput"
            label="Nom"
            label-visible
            type="text"
            name="userFullName"
            :required="true"
            disabled
          />
        </DsfrInputGroup>

        <DsfrInputGroup :error-message="utils.showInputError(v$, 'userEmail')">
          <DsfrInput
            id="email"
            v-model="arreteMunicipal.userEmail"
            data-cy="FormEmailInput"
            label="Email"
            label-visible
            type="text"
            name="userEmail"
            :required="true"
            disabled
          />
        </DsfrInputGroup>

        <DsfrInputGroup :error-message="utils.showInputError(v$, 'userPhone')">
          <DsfrInput
            id="phone"
            v-model="arreteMunicipal.userPhone"
            data-cy="FormPhoneInput"
            label="Numéro de téléphone"
            hint="Format attendu : (+33) 1 22 33 44 55"
            label-visible
            type="text"
            name="userPhone"
            :required="true"
          />
        </DsfrInputGroup>

        <DsfrAlert type="info" title="Liste des codes INSEE concernés par l'arrêté" class="fr-mb-2w">
          Pour créer votre arrêté vous allez devoir nous fournir les codes INSEE de chaque commune concernée. Copier / coller à partir de la
          liste des codes correspondant à un groupement.
          <br /><a class="fr-link" href="https://www.insee.fr/fr/information/2560452" target="_blank">Liste des codes INSEE</a>
        </DsfrAlert>

        <DsfrInputGroup :error-message="utils.showInputError(v$, 'communes')">
          <DsfrInput
            :model-value="communesText"
            data-cy="CommunesFormNomInput"
            label="Coller ici le code INSEE de votre commune."
            label-visible
            is-textarea
            required
            type="text"
            :disabled="communesLoading || communes.length <= 0"
            @update:model-value="parseCommunes($event)"
          />
          <p v-if="communesLoading" class="fr-mt-1w">
            <VIcon name="ri-loader-4-line" animation="spin" />
            Chargement des communes...
          </p>
          <p>
            {{ props.arreteMunicipal.communes?.length }} communes associées
            <br />
            {{ hint }}
          </p>
        </DsfrInputGroup>

        <p class="fr-mb-0">Choisissez la date d’entrée en vigueur de l’arrêté et sa date de fin</p>
        <p class="fr-mb-1w">
          L’arrêté sera publié sur VigiEau entre sa date de début et sa date de fin. Vous pourrez toujours modifier la date de fin après la
          publication.
        </p>
        <div class="fr-grid-row fr-grid-row--gutters">
          <div class="fr-col-12 fr-col-lg-6">
            <DsfrInputGroup :error-message="utils.showInputError(v$, 'dateDebut')">
              <DsfrInput
                id="dateDebut"
                v-model="arreteMunicipal.dateDebut"
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
              <DsfrInput
                id="dateFin"
                v-model="arreteMunicipal.dateFin"
                label="Date de fin"
                label-visible
                type="date"
                name="dateFin"
                data-cy="PublishFormDateFinInput"
                :required="true"
              />
            </DsfrInputGroup>
          </div>
        </div>

        <div v-if="arreteMunicipal.fichier" class="fr-mt-4w">
          <DsfrFileDownload
            format="PDF"
            :href="fileAccessUrl(arreteMunicipal.fichier.id)"
            :size="utils.fileSizeString(arreteMunicipal.fichier.size)"
            :download="arreteMunicipal.fichier.nom"
            :title="arreteMunicipal.fichier.nom"
          />
        </div>

        <div class="fr-mt-4w">
          <DsfrInputGroup :error-message="utils.showInputError(v$, 'file')">
            <DsfrFileUpload
              :required="!arreteMunicipal.fichier"
              :label="arreteMunicipal.fichier ? 'Modifier le PDF de l\'arrêté' : 'Importer le PDF de l\'arrêté'"
              hint="Taille maximale autorisée : 10Mo. Le nom du fichier ne doit pas dépasser 100 caractères, évitez les espaces et caractères spéciaux."
              :arrete-cadrecept="['application/pdf']"
              data-cy="PublishFormFileInput"
              @change="arreteMunicipal.file = $event[0]"
            />
          </DsfrInputGroup>
        </div>
      </div>
    </div>
  </form>
</template>
