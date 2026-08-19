<script setup lang="ts">
import type { Ref } from 'vue';
import useVuelidate from '@vuelidate/core/dist/index';
import { useRefDataStore } from '~/stores/refData';
import { useAlertStore } from '~/stores/alert';
import type { ArreteRestriction } from '~/dto/arrete_restriction.dto';
import type { Restriction } from '~/dto/restriction.dto';
import type { Usage } from '~/dto/usage.dto';

const props = defineProps<{
  arreteRestriction: ArreteRestriction;
}>();

const api = useApi();
const router = useRouter();
const refDataStore = useRefDataStore();
const alertStore = useAlertStore();
const utils = useUtils();
const apiErrorHandler = useApiErrorHandler();
const loading = ref(false);
const componentKey = ref(0);
const asc = ref(true);
const checkReturn: Ref<{ errors: string[]; warnings: string[] } | null | undefined> = ref();

const currentStep: Ref<number> = ref(1);

const v$ = useVuelidate();

const nextStep = async () => {
  asc.value = true;
  let errors;
  switch (currentStep.value) {
    case 1:
      await generalFormRef.value?.v$.$validate();
      errors = generalFormRef.value?.v$.$errors;
      break;
    case 2:
      await reglesFormRef.value?.v$.$validate();
      errors = reglesFormRef.value?.v$.$errors;
      break;
    case 3:
      if (showRestrictionsAepForm.value) {
        await restrictionsAepFormRef.value?.v$.$validate();
        errors = restrictionsAepFormRef.value?.v$.$errors;
      } else {
        await restrictionsFormRef.value?.v$.$validate();
        errors = restrictionsFormRef.value?.v$.$errors;
      }
      break;
    case 4:
      if (showRestrictionsForm.value && showRestrictionsAepForm.value) {
        await restrictionsFormRef.value?.v$.$validate();
        errors = restrictionsFormRef.value?.v$.$errors;
      } else {
        await graviteFormRef.value?.v$.$validate();
        errors = graviteFormRef.value?.v$.$errors;
      }
      break;
    case 5:
      await graviteFormRef.value?.v$.$validate();
      errors = graviteFormRef.value?.v$.$errors;
      break;
  }
  if (errors && errors.length > 0) {
    return;
  }
  currentStep.value++;
  utils.scrollToTop();
};

const previousStep = () => {
  asc.value = false;
  currentStep.value--;
  utils.scrollToTop();
};

const publicationContext = (action: string) => ({
  action,
  arreteType: 'arrete_restriction',
  arreteId: props.arreteRestriction.id,
  numero: props.arreteRestriction.numero,
  statut: props.arreteRestriction.statut,
  departement: props.arreteRestriction.departement?.code,
});

const getRestrictionLabel = (restriction: Restriction) =>
  restriction.zoneAlerte?.nom || restriction.nomGroupementAep || 'restriction sans libellé';

const normalizeAepGroupName = (value?: string | null) => (value ?? '').trim().normalize('NFKC').toLocaleLowerCase('fr-FR');

const syncSavedRestrictionIds = (savedArreteRestriction: ArreteRestriction) => {
  props.arreteRestriction.restrictions.forEach((restriction: Restriction) => {
    const restrictionReturned = restriction.id
      ? savedArreteRestriction.restrictions?.find((candidate: Restriction) => candidate.id === restriction.id)
      : savedArreteRestriction.restrictions?.find((candidate: Restriction) =>
          candidate.zoneAlerte
            ? candidate.zoneAlerte.id === restriction.zoneAlerte?.id
            : normalizeAepGroupName(candidate.nomGroupementAep) === normalizeAepGroupName(restriction.nomGroupementAep),
        );

    if (!restrictionReturned?.id) {
      throw new Error(`La restriction "${getRestrictionLabel(restriction)}" n'a pas été renvoyée par l'API après enregistrement.`);
    }

    restriction.id = restrictionReturned.id;
    (restriction.usages ?? []).forEach((usagesArreteRestriction: Usage) => {
      const savedUsage = restrictionReturned.usages?.find((u: Usage) => u.nom === usagesArreteRestriction.nom);

      if (!savedUsage?.id) {
        throw new Error(
          `L'usage "${usagesArreteRestriction.nom}" de la restriction "${getRestrictionLabel(restriction)}" n'a pas été renvoyé par l'API après enregistrement.`,
        );
      }

      usagesArreteRestriction.id = savedUsage.id;
    });
  });
};

const saveArrete = async (publish: boolean = false): Promise<boolean> => {
  if (loading.value) {
    return false;
  }
  if (publish) {
    await v$.value.$validate();
  } else {
    await generalFormRef.value?.v$.$validate();
  }
  if (publish ? v$.value.$error : generalFormRef.value?.v$.$error) {
    showErrors(publish ? v$.value.$errors : generalFormRef.value?.v$.$errors, publish);
    return false;
  }

  let shouldPublishAfterSave = false;
  loading.value = true;

  try {
    const arToSend = JSON.parse(JSON.stringify(props.arreteRestriction));
    arToSend.arretesCadre = arToSend.arretesCadre.map((ac: any) => {
      return {
        id: ac.id,
      };
    });
    arToSend.restrictions = arToSend.restrictions.map((r: any) => {
      r.zoneAlerte = r.zoneAlerte ? { id: r.zoneAlerte.id } : null;
      r.communes = r.communes
        ? r.communes.map((c: any) => {
            return { id: c.id };
          })
        : [];
      return r;
    });
    const { data, error } = props.arreteRestriction.id
      ? await api.arreteRestriction.update(props.arreteRestriction.id.toString(), arToSend)
      : await api.arreteRestriction.create({ ...arToSend });

    if (error.value) {
      apiErrorHandler.captureClientError(error.value, publicationContext(publish ? 'save_before_publish' : 'save'));
      return false;
    }

    if (!data.value?.id) {
      throw new Error('La réponse de l’API ne contient pas d’identifiant d’arrêté de restriction.');
    }

    // Mise à jour des ids des objets nouvellement crées
    props.arreteRestriction.id = data.value.id;
    syncSavedRestrictionIds(data.value as ArreteRestriction);
    componentKey.value++;

    shouldPublishAfterSave = props.arreteRestriction.statut !== 'a_valider';
  } catch (error) {
    apiErrorHandler.showError(
      error,
      publish ? "Impossible de préparer la publication de l'arrêté de restriction" : "Impossible d'enregistrer l'arrêté de restriction",
      'Une erreur technique empêche l’enregistrement de l’arrêté de restriction.',
      publicationContext(publish ? 'save_before_publish_exception' : 'save_exception'),
    );
    return false;
  } finally {
    loading.value = false;
  }

  if (shouldPublishAfterSave) {
    return await publishArrete(props.arreteRestriction);
  }

  if (!publish) {
    alertStore.addAlert({
      description: 'Enregistrement réussi',
      type: 'success',
    });
  }

  return true;
};

const checkArrete = async (ar: ArreteRestriction): Promise<boolean> => {
  if (loading.value) {
    return false;
  }
  loading.value = true;

  try {
    const { data, error } = await api.arreteRestriction.check(ar.id?.toString(), ar);

    if (error.value) {
      checkReturn.value = null;
      apiErrorHandler.captureClientError(error.value, publicationContext('check_before_publish'));
      return false;
    }

    checkReturn.value = data.value || null;
    return true;
  } catch (error) {
    checkReturn.value = null;
    apiErrorHandler.showError(
      error,
      "Impossible de vérifier l'arrêté de restriction",
      'Une erreur technique empêche la vérification avant publication.',
      publicationContext('check_before_publish_exception'),
    );
    return false;
  } finally {
    loading.value = false;
  }
};

const showErrors = (errors, publish) => {
  alertStore.addAlert({
    title: publish ? "Impossible de publier l'arrêté de restriction" : "Impossible d'enregistrer l'arrêté de restriction",
    description: errors.map((e: any) => e.$message).join(', '),
    type: 'error',
  });
};

const askPublishArrete = async () => {
  const saved = await saveArrete(true);
  if (saved && !v$.value.$error) {
    modalPublishOpened.value = true;
  }
};

const publishArrete = async (ar: ArreteRestriction): Promise<boolean> => {
  if (loading.value) {
    return false;
  }

  const checked = await checkArrete(ar);
  if (!checked) {
    return false;
  }
  if (checkReturn.value?.errors?.length > 0) {
    alertStore.addAlert({
      title: "Impossible de publier l'arrêté de restriction",
      description: checkReturn.value?.errors.join(', '),
      type: 'error',
    });
    return false;
  }
  loading.value = true;

  try {
    const { data, error } = await api.arreteRestriction.publish(ar.id?.toString(), ar);

    if (error.value) {
      apiErrorHandler.captureClientError(error.value, publicationContext('publish'));
      return false;
    }

    if (!data.value) {
      throw new Error('La réponse de l’API ne confirme pas la publication de l’arrêté de restriction.');
    }

    modalPublishOpened.value = utils.closeModal(modalPublishOpened);
    await navigateTo('/arrete-restriction');
    alertStore.addAlert({
      description: 'Publication réussie',
      type: 'success',
    });
    return true;
  } catch (error) {
    apiErrorHandler.showError(
      error,
      "Impossible de publier l'arrêté de restriction",
      'Une erreur technique empêche la publication de l’arrêté de restriction.',
      publicationContext('publish_exception'),
    );
    return false;
  } finally {
    loading.value = false;
  }
};

const getRestrictionByNiveauDeGravite = (niveauGravite: string) => {
  return props.arreteRestriction.restrictions.filter((restriction) => restriction.niveauGravite === niveauGravite);
};

const showRestrictionsForm = computed(() => {
  return props.arreteRestriction.perimetreAr !== 'aep';
});

const showRestrictionsAepForm = computed(() => {
  return (
    props.arreteRestriction.perimetreAr === 'aep' ||
    (props.arreteRestriction.perimetreAr === 'all' && props.arreteRestriction.niveauGraviteSpecifiqueEap)
  );
});

const totalSteps = computed(() => {
  return showRestrictionsForm.value && showRestrictionsAepForm.value ? 6 : 5;
});

const subscriptions = computed(() => {
  return refDataStore.departements.find((d) => props.arreteRestriction.departement?.id === d.id)?.subscriptions;
});

const steps = computed(() => {
  if (showRestrictionsForm.value && !showRestrictionsAepForm.value) {
    return [
      'Informations générales',
      'Ressources concernées par les restrictions',
      "Liste des zones d'alertes",
      'Niveaux de gravité et usages',
      'Usages',
    ];
  } else if (showRestrictionsForm.value && showRestrictionsAepForm.value) {
    return [
      'Informations générales',
      'Ressources concernées par les restrictions',
      "Liste des zones d'alertes AEP",
      "Liste des zones d'alertes",
      'Niveaux de gravité et usages',
      'Usages',
    ];
  } else {
    return [
      'Informations générales',
      'Ressources concernées par les restrictions',
      "Liste des zones d'alertes AEP",
      'Niveaux de gravité et usages',
      'Usages',
    ];
  }
});

// PUBLISH MODAL
const modalPublishOpened: Ref<boolean> = ref(false);
const modalTitle: Ref<string> = ref('Récapitulatif et publication de l’arrêté de restriction');
const publierFormRef = ref(null);

// Forms
const generalFormRef = ref(null);
const reglesFormRef = ref(null);
const restrictionsFormRef = ref(null);
const restrictionsAepFormRef = ref(null);
const graviteFormRef = ref(null);
</script>

<template>
  <DsfrStepper :steps="steps" :currentStep="currentStep" />
  <DsfrTabs class="tabs-light" v-if="refDataStore.departements.length > 0">
    <DsfrTabContent :selected="currentStep === 1" :asc="asc">
      <ArreteRestrictionFormGeneral ref="generalFormRef" :arreteRestriction="arreteRestriction" :checkReturn="checkReturn" />
    </DsfrTabContent>
    <DsfrTabContent :selected="currentStep === 2" :asc="asc">
      <ArreteRestrictionFormRegles ref="reglesFormRef" :arreteRestriction="arreteRestriction" />
    </DsfrTabContent>
    <DsfrTabContent v-if="showRestrictionsAepForm" :selected="currentStep === 3" :asc="asc">
      <ArreteRestrictionFormZonesAep
        ref="restrictionsAepFormRef"
        :selected="showRestrictionsForm ? currentStep === totalSteps - 3 : currentStep === totalSteps - 2"
        :arreteRestriction="arreteRestriction"
      />
    </DsfrTabContent>
    <DsfrTabContent v-if="showRestrictionsForm" :selected="currentStep === totalSteps - 2" :asc="asc">
      <ArreteRestrictionFormZones ref="restrictionsFormRef" :selected="currentStep === 3" :arreteRestriction="arreteRestriction" />
    </DsfrTabContent>
    <DsfrTabContent :selected="currentStep === totalSteps - 1" :asc="asc">
      <ArreteRestrictionFormGravite
        ref="graviteFormRef"
        :key="currentStep"
        :selected="currentStep === totalSteps - 1"
        :arreteRestriction="arreteRestriction"
        @editUsages="nextStep()"
      />
    </DsfrTabContent>
    <DsfrTabContent :selected="currentStep === totalSteps" :asc="asc">
      <ArreteRestrictionFormUsages
        :key="currentStep"
        :selected="currentStep === totalSteps"
        :arreteRestriction="arreteRestriction"
      />
    </DsfrTabContent>
  </DsfrTabs>
  <ul
    class="fr-btns-group--sticky fr-btns-group fr-btns-group--md fr-btns-group--inline-sm fr-btns-group--inline-md fr-btns-group--inline-lg fr-mt-4w"
  >
    <li>
      <DsfrButton
        :label="currentStep !== totalSteps ? 'Précedent' : 'Retour aux restrictions'"
        :secondary="true"
        icon="ri-arrow-left-line"
        data-cy="ArreteRestrictionFormPreviousStepBtn"
        :disabled="currentStep === 1"
        @click="previousStep()"
      />
    </li>
    <li>
      <DsfrButton
        v-if="currentStep !== totalSteps"
        :label="arreteRestriction.statut === 'a_valider' ? 'Enregistrer en brouillon' : 'Enregistrer'"
        data-cy="ArreteRestrictionFormSaveBtn"
        :secondary="true"
        :icon="loading ? { name: 'ri-settings-3-line', animation: 'spin' } : 'ri-settings-3-line'"
        :disabled="loading"
        @click="saveArrete(arreteRestriction.statut !== 'a_valider')"
      />
    </li>
    <li>
      <DsfrButton
        v-if="currentStep !== totalSteps"
        label="Suivant"
        :secondary="true"
        icon="ri-arrow-right-line"
        data-cy="ArreteRestrictionFormNextStepBtn"
        :disabled="currentStep >= totalSteps - 1"
        @click="nextStep()"
      />
    </li>
    <li v-if="currentStep === totalSteps - 1 && arreteRestriction.statut === 'a_valider'">
      <DsfrButton
        label="Publier"
        :disabled="loading"
        :icon="loading ? { name: 'ri-loader-4-line', animation: 'spin' } : ''"
        :iconRight="true"
        data-cy="ArreteRestrictionFormPublishBtn"
        @click="askPublishArrete()"
      />
    </li>
    <li style="margin-left: auto">
      <DsfrButton
        v-if="currentStep !== totalSteps"
        label="Retour à la liste"
        icon="ri-arrow-left-line"
        secondary
        @click="router.push('/arrete-restriction')"
      />
    </li>
  </ul>
  <DsfrModal
    :opened="modalPublishOpened"
    icon="ri-arrow-right-line"
    :title="modalTitle"
    @close="modalPublishOpened = utils.closeModal(modalPublishOpened)"
  >
    <div>
      Cet arrêté de restriction contient&nbsp;:
      <ul>
        <li v-if="getRestrictionByNiveauDeGravite('vigilance').length > 0">
          {{ getRestrictionByNiveauDeGravite('vigilance').length }} zone(s) en vigilance
        </li>
        <li v-if="getRestrictionByNiveauDeGravite('alerte').length > 0">
          {{ getRestrictionByNiveauDeGravite('alerte').length }} zone(s) en alerte
        </li>
        <li v-if="getRestrictionByNiveauDeGravite('alerte_renforcee').length > 0">
          {{ getRestrictionByNiveauDeGravite('alerte_renforcee').length }} zone(s) en alerte renforcée
        </li>
        <li v-if="getRestrictionByNiveauDeGravite('crise').length > 0">
          {{ getRestrictionByNiveauDeGravite('crise').length }} zone(s) en crise
        </li>
      </ul>
      <span> {{ subscriptions }} usagers de VigiEau seront prévenus par mail. </span>
      <div class="divider fr-mt-1w"></div>
    </div>
    <ArreteRestrictionFormPublier
      ref="publierFormRef"
      :arreteRestriction="arreteRestriction"
      :warnings="checkReturn?.warnings"
      :errors="checkReturn?.errors"
      @publier="publishArrete($event)"
    />
    <template #footer>
      <ul class="fr-btns-group fr-btns-group--md fr-btns-group--inline-sm fr-btns-group--inline-md fr-btns-group--inline-lg fr-mt-4w">
        <li v-if="currentStep !== 1">
          <DsfrButton
            label="Annuler"
            :disabled="loading"
            :secondary="true"
            @click="modalPublishOpened = utils.closeModal(modalPublishOpened)"
          />
        </li>
        <li>
          <DsfrButton
            label="Publier"
            data-cy="PublishFormPublishBtn"
            :icon="loading ? { name: 'ri-loader-4-line', animation: 'spin' } : ''"
            :disabled="loading"
            @click="publierFormRef.submitForm()"
          />
        </li>
      </ul>
    </template>
  </DsfrModal>
</template>
