<script setup lang="ts">
import { ArreteCadre } from '~/dto/arrete_cadre.dto';
import type { Ref } from 'vue';
import useVuelidate from '@vuelidate/core/dist/index';
import { useRefDataStore } from '~/stores/refData';
import { useAlertStore } from '~/stores/alert';
import { useAuthStore } from '~/stores/auth';
import type { Usage } from '~/dto/usage.dto';

const props = defineProps<{
  arreteCadre: ArreteCadre;
}>();

const api = useApi();
const router = useRouter();
const refDataStore = useRefDataStore();
const alertStore = useAlertStore();
const authStore = useAuthStore();
const utils = useUtils();
const loading = ref(false);
const componentKey = ref(0);
const asc = ref(true);
const isDepPilote: Ref<boolean | null> = ref(authStore.user?.role === 'mte' || authStore.user?.roleDepartements.includes(props.arreteCadre.departementPilote?.code));

const usageSelected = ref();

const currentStep: Ref<number> = ref(!props.arreteCadre.id || !props.arreteCadre.departementPilote || isDepPilote.value ? 1 : 2);

const v$ = useVuelidate();

const showRessourcesInfluencees = computed(() => {
  return props.arreteCadre.zonesAlerte.some(z => z.ressourceInfluencee);
});

const steps = computed(() => {
  if (showRessourcesInfluencees.value) {
    return [
      'Informations générales',
      'Liste des zones d\'alertes',
      'Emprise géographique des ressources influencées',
      'Mesures de restriction',
      'Récapitulatif',
    ];
  } else {
    return [
      'Informations générales',
      'Liste des zones d\'alertes',
      'Mesures de restriction',
      'Récapitulatif',
    ];
  }
});

const nextStep = async () => {
  asc.value = true;
  let errors;
  switch (currentStep.value) {
    case 1:
      await generalFormRef.value?.v$.$validate();
      errors = generalFormRef.value?.v$.$errors;
      break;
    case 2:
      await zonesFormRef.value?.v$.$validate();
      errors = zonesFormRef.value?.v$.$errors;
      break;
    case 3:
      if (!showRessourcesInfluencees.value) {
        await usagesFormRef.value?.v$.$validate();
        errors = usagesFormRef.value?.v$.$errors;
      }
      break;
    case 4:
      await usagesFormRef.value?.v$.$validate();
      errors = usagesFormRef.value?.v$.$errors;
      break;
  }
  if (errors && errors.length > 0) {
    showErrors(v$.value.$errors, null);
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

const saveArrete = async (publish: boolean = false) => {
  if (loading.value) {
    return;
  }
  publish ? v$.value.$validate() :
    generalFormRef.value?.v$.$validate() && usagesFormRef.value?.arreteCadreUsageListRef.v$.$validate();
  if (publish ? v$.value.$error : generalFormRef.value?.v$.$error || usagesFormRef.value?.arreteCadreUsageListRef.v$.$error) {
    showErrors(v$.value.$errors, publish ? 'Impossible de publier l\'arrêté cadre' : 'Impossible d\'enregistrer l\'arrêté cadre');
    return;
  }
  loading.value = true;
  const { data, error } = props.arreteCadre.id
    ? await api.arreteCadre.update(props.arreteCadre.id.toString(), props.arreteCadre)
    : await api.arreteCadre.create({ ...props.arreteCadre });
  if (data.value?.id) {
    // Mise à jour des ids des objets nouvellement crées
    props.arreteCadre.id = data.value.id;
    props.arreteCadre.usages.map((usageArreteCadre: Usage) => {
      usageArreteCadre.id = (<ArreteCadre>data.value).usages.find(
        (uac: Usage) => uac.nom === usageArreteCadre.nom,
      ).id;
      return usageArreteCadre;
    });
    componentKey.value++;
    loading.value = false;
    if (props.arreteCadre.statut !== 'a_valider') {
      await publishArrete(props.arreteCadre);
    }
    if (!publish) {
      alertStore.addAlert({
        description: 'Enregistrement réussi',
        type: 'success',
      });
    }
  }
  loading.value = false;
};

const showErrors = (errors: any, title: string | null) => {
  alertStore.addAlert({
    title: title,
    description: errors.filter((e: any) => e.$message).map((e: any) => {
      if (Array.isArray(e.$message)) {
        return e.$message.flat().filter((m: any) => m).join(', ');
      }
      return e.$message;
    }).join(', '),
    type: 'error',
  });
};

const askPublishArrete = async () => {
  await saveArrete(true);
  if (!v$.value.$error) {
    modalPublishOpened.value = true;
  }
};

const publishArrete = async (ac: ArreteCadre) => {
  if (loading.value) {
    return;
  }
  loading.value = true;
  const { data, error } = await api.arreteCadre.publish(ac.id?.toString(), ac);
  if (data.value) {
    utils.closeModal(modalPublishOpened);
    navigateTo('/arrete-cadre');
    alertStore.addAlert({
      description: 'Publication réussie',
      type: 'success',
    });
  }
  loading.value = false;
};

// PUBLISH MODAL
const modalPublishOpened: Ref<boolean> = ref(false);
const modalTitle: Ref<string> = ref('Récapitulatif et publication');
const publierFormRef = ref(null);

// Forms
const generalFormRef = ref(null);
const zonesFormRef = ref(null);
const usagesFormRef = ref(null);
const ressourcesInfluenceesFormRef = ref(null);
</script>

<template>
  <DsfrStepper :steps="steps" :currentStep="currentStep" />
  <DsfrTabs class="tabs-light"
            v-if="refDataStore.departements.length > 0"
            @select-tab="utils.scrollToTop()">
    <DsfrTabContent :selected="currentStep === 1" :asc="asc">
      <ArreteCadreFormGeneral
        ref="generalFormRef"
        :arrete-cadre="arreteCadre" />
    </DsfrTabContent>
    <DsfrTabContent :selected="currentStep === 2" :asc="asc">
      <ArreteCadreFormZones
        ref="zonesFormRef"
        :arrete-cadre="arreteCadre" />
    </DsfrTabContent>
    <DsfrTabContent v-if="showRessourcesInfluencees" :selected="currentStep === 3" :asc="asc">
      <ArreteCadreFormRessourceInfluencee
        ref="ressourcesInfluenceesFormRef"
        :arrete-cadre="arreteCadre"
      />
    </DsfrTabContent>
    <DsfrTabContent :selected="showRessourcesInfluencees ? currentStep === 4 : currentStep === 3" :asc="asc">
      <ArreteCadreFormUsages
        ref="usagesFormRef"
        :arrete-cadre="arreteCadre"
        :usageSelected="usageSelected"
        :key="componentKey + currentStep"
        @resetUsageSelected="usageSelected = null"
      />
    </DsfrTabContent>
    <DsfrTabContent :selected="showRessourcesInfluencees ? currentStep === 5 : currentStep === 4" :asc="asc">
      <ArreteCadreFormRecapitulatif
        :arrete-cadre="arreteCadre"
        :key="componentKey + currentStep"
        :view-only="false"
        @usageSelected="
          usageSelected = $event;
          previousStep();
        "
      />
    </DsfrTabContent>
  </DsfrTabs>
  <ul
    class="fr-btns-group--sticky fr-btns-group fr-btns-group--md fr-btns-group--inline-sm fr-btns-group--inline-md fr-btns-group--inline-lg fr-mt-4w">
    <li>
      <DsfrButton label="Précedent"
                  :secondary="true"
                  icon="ri-arrow-left-line"
                  data-cy="ArreteCadreFormPreviousStepBtn"
                  :disabled="currentStep === 1"
                  @click="previousStep()" />
    </li>
    <li>
      <DsfrButton
        :label="arreteCadre.statut === 'a_valider' ? 'Enregistrer en brouillon' : 'Enregistrer'"
        data-cy="ArreteCadreFormSaveBtn"
        :secondary="true"
        :icon="loading ? { name: 'ri-settings-3-line', animation: 'spin' } : 'ri-settings-3-line'"
        :disabled="loading"
        @click="saveArrete(arreteCadre.statut !== 'a_valider')"
      />
    </li>
    <li v-if="showRessourcesInfluencees ? currentStep !== 5 : currentStep !== 4">
      <DsfrButton label="Suivant"
                  :secondary="true"
                  icon="ri-arrow-right-line"
                  data-cy="ArreteCadreFormNextStepBtn"
                  @click="nextStep()" />
    </li>
    <li v-if="(showRessourcesInfluencees ? currentStep === 5 : currentStep === 4) && arreteCadre.statut === 'a_valider'">
      <DsfrButton
        label="Publier"
        :disabled="loading"
        :icon="loading ? { name: 'ri-loader-4-line', animation: 'spin' } : ''"
        :iconRight="true"
        data-cy="ArreteCadreFormPublishBtn"
        @click="askPublishArrete()"
      />
    </li>
    <li style="margin-left: auto;">
      <DsfrButton
        label="Retour à la liste"
        icon="ri-arrow-left-line"
        secondary
        @click="router.push('/arrete-cadre')"
      />
    </li>
  </ul>
  <DsfrModal :opened="modalPublishOpened"
             icon="ri-arrow-right-line"
             :title="modalTitle"
             @close="modalPublishOpened = utils.closeModal(modalPublishOpened);">
    <p>
      Cet arrêté cadre contient&nbsp;:
      <ul>
        <li v-if="arreteCadre.departements.length > 1">{{ arreteCadre.departements.length }} départements</li>
        <li>{{ arreteCadre.zonesAlerte.length }} zones d'alerte</li>
        <li>{{ arreteCadre.usages.length }} usages</li>
      </ul>
      <div class="divider"></div>
    </p>
    <ArreteCadreFormPublier :showDateFin="false" ref="publierFormRef" :arrete-cadre="arreteCadre" @publier="publishArrete($event)" />
    <template #footer>
      <ul class="fr-btns-group fr-btns-group--md fr-btns-group--inline-sm fr-btns-group--inline-md fr-btns-group--inline-lg fr-mt-4w">
        <li v-if="currentStep !== 1">
          <DsfrButton label="Annuler"
                      :disabled="loading"
                      :secondary="true"
                      @click="modalPublishOpened = utils.closeModal(modalPublishOpened);" />
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
