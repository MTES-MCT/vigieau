<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import api from '../../api';
import { getHttpErrorStatus, isZoneRestrictionsConflict } from '../../utils/zone-publication';

definePageMeta({
  layout: 'basic',
});

useHead({
  title: `Abonnement aux alertes VigiEau - ${useRuntimeConfig().public.appName}`,
});

const router = useRouter();
const mailForm = ref<{ focus: () => void } | null>(null);
const resultModal = ref<'success' | 'error' | null>(null);
const subscribing = ref(false);
const serviceUnavailable = ref(false);
const restrictionsConflict = ref(false);
const confirmationUnavailable = ref(false);
const requestsLimited = ref(false);
const resultModalOpened = computed(() => resultModal.value !== null);
const resultModalId = computed(() => (
  resultModal.value === 'success'
    ? 'subscription-success-title'
    : 'subscription-error-title'
));
const resultModalTitle = computed(() => (
  resultModal.value === 'success'
    ? 'Abonnement confirmé'
    : confirmationUnavailable.value
      ? 'Abonnement enregistré, e-mail non envoyé'
      : 'L’abonnement n’a pas pu être enregistré'
));
const resultModalDescription = computed(() => {
  if (resultModal.value === 'success') {
    return 'Vous êtes désormais abonné. Vous recevrez un e-mail très prochainement. Vous souhaitez recevoir les alertes pour plusieurs adresses ? Il vous suffit de remplir de nouveau le formulaire avec la ou les nouvelles adresses.';
  }
  if (confirmationUnavailable.value) {
    return 'Votre abonnement est enregistré, mais l’e-mail de confirmation n’a pas pu être envoyé. Fermez cette fenêtre et réessayez avec le même formulaire pour recevoir votre confirmation.';
  }
  if (requestsLimited.value) {
    return 'Trop de demandes ont été effectuées. Patientez 15 minutes avant de réessayer.';
  }
  if (restrictionsConflict.value) {
    return 'Les restrictions applicables à cette adresse ne peuvent pas être confirmées en raison d’un chevauchement de zones non résolu. Consultez les arrêtés publiés par votre préfecture.';
  }
  if (serviceUnavailable.value) {
    return 'Le service est temporairement indisponible. Veuillez réessayer dans quelques instants.';
  }
  return 'Veuillez réessayer avec une autre adresse.';
});

const closeResultModal = async () => {
  if (!resultModal.value) {
    return;
  }

  const closedResult = resultModal.value;
  resultModal.value = null;
  await nextTick();

  if (closedResult === 'success') {
    router.go(-1);
  } else {
    mailForm.value?.focus();
  }
};

const subscribe = async (form: any) => {
  if (subscribing.value) return;
  subscribing.value = true;
  resultModal.value = null;
  serviceUnavailable.value = false;
  restrictionsConflict.value = false;
  confirmationUnavailable.value = false;
  requestsLimited.value = false;

  try {
    const { error } = await api.subscribeMail(form);
    if (!error.value) {
      resultModal.value = 'success';
    } else {
      setSubscriptionError(error.value);
      resultModal.value = 'error';
    }
  } catch (error) {
    setSubscriptionError(error);
    resultModal.value = 'error';
  } finally {
    subscribing.value = false;
  }
};

const setSubscriptionError = (error: any) => {
  const status = getHttpErrorStatus(error);
  requestsLimited.value = status === 429;
  serviceUnavailable.value = !status || status >= 500;
  restrictionsConflict.value = isZoneRestrictionsConflict(error);
  confirmationUnavailable.value = (error?.data?.code ?? error?.response?._data?.code)
    === 'SUBSCRIPTION_CONFIRMATION_UNAVAILABLE';
};
</script>

<template>
  <div class="fr-container">
    <DsfrButton
      class="fr-my-1w"
      type="button"
      secondary
      icon="ri-arrow-left-line"
      title="Retour à la page précédente"
      @click="router.go(-1)"
    >
      Retour
    </DsfrButton>
    <h1>M’abonner aux alertes VigiEau</h1>
    <p>Tenez-vous au courant des changements de situation de votre territoire.</p>
    <MailForm
      ref="mailForm"
      :subscribing="subscribing"
      @subscribe="subscribe($event)"
    />
  </div>
  <AccessibleModal
    :modal-id="resultModalId"
    :opened="resultModalOpened"
    :origin="mailForm ?? undefined"
    :title="resultModalTitle"
    :is-alert="resultModal === 'error'"
    @close="closeResultModal"
  >
    <p>{{ resultModalDescription }}</p>
  </AccessibleModal>
</template>
