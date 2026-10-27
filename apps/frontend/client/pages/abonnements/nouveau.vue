<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import api from '../../api';
import { getHttpErrorStatus } from '../../utils/zone-publication';

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
const resultModalOpened = computed(() => resultModal.value !== null);
const resultModalId = computed(() => (
  resultModal.value === 'success'
    ? 'subscription-success-title'
    : 'subscription-error-title'
));
const resultModalTitle = computed(() => (
  resultModal.value === 'success'
    ? 'Abonnement confirmé'
    : 'L’abonnement n’a pas pu être enregistré'
));
const resultModalDescription = computed(() => (
  resultModal.value === 'success'
    ? 'Vous êtes désormais abonné. Vous recevrez un e-mail très prochainement. Vous souhaitez recevoir les alertes pour plusieurs adresses ? Il vous suffit de remplir de nouveau le formulaire avec la ou les nouvelles adresses.'
    : serviceUnavailable.value
      ? 'Le service est temporairement indisponible. Veuillez réessayer dans quelques instants.'
      : 'Veuillez réessayer avec une autre adresse.'
));

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
  subscribing.value = true;
  resultModal.value = null;
  serviceUnavailable.value = false;

  try {
    const { error } = await api.subscribeMail(form);
    if (!error.value) {
      resultModal.value = 'success';
    } else {
      serviceUnavailable.value = getHttpErrorStatus(error.value) === 503;
      resultModal.value = 'error';
    }
  } catch (error) {
    serviceUnavailable.value = getHttpErrorStatus(error) === 503;
    resultModal.value = 'error';
  } finally {
    subscribing.value = false;
  }
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
