<script setup lang="ts">

import api from '../../api';
import { Ref } from 'vue';
import { Subscription } from '../../dto/subscription.dto';

definePageMeta({
  layout: 'basic',
  middleware: 'abonnements',
});

useHead({
  title: `Abonnements - ${useRuntimeConfig().public.appName}`,
});
const links: Ref<any[]> = ref([{ 'to': '/', 'text': 'Accueil' }, { 'text': 'Abonnements' }]);
const loading: Ref<boolean> = ref(false);
const modalOpened: Ref<boolean> = ref(false);
const modalTitle: Ref<string> = ref('');
const modalIcon: Ref<string> = ref('');
const subscriptionsToUnsubscribe: Ref<Subscription[]> = ref([]);
const unsubscribeError = ref('');
const unsubscribeStatus = ref('');

const router = useRouter();
const route = useRoute();
const { data: userSubscriptions, error } = await api.getUserSubscriptions(route.query.token);

if (!userSubscriptions.value || userSubscriptions.value.length < 1 || error.value) {
  router.push('/');
}

const unsubscribe = async () => {
  if (loading.value) {
    return;
  }

  const ids = subscriptionsToUnsubscribe.value.map(subscription => subscription.id);
  if (ids.length < 1) {
    return;
  }

  loading.value = true;
  unsubscribeError.value = '';
  unsubscribeStatus.value = '';
  let requestFailed = false;

  try {
    const response = ids.length > 1
      ? await api.unsubscribeAll(route.query.token)
      : await api.unsubscribe(ids[0], route.query.token);
    requestFailed = Boolean(response.error?.value);
  } catch {
    requestFailed = true;
  } finally {
    loading.value = false;
  }

  if (requestFailed) {
    unsubscribeError.value = 'Le désabonnement n’a pas pu être effectué. Veuillez réessayer.';
    await nextTick();
    document.getElementById('unsubscribe-error')?.focus();
    return;
  }

  userSubscriptions.value = userSubscriptions.value.filter(subscription => !ids.includes(subscription.id));
  unsubscribeStatus.value = ids.length > 1
    ? 'Désabonnement de toutes les adresses effectué.'
    : 'Désabonnement de l’adresse effectué.';
  modalOpened.value = false;
  await nextTick();

  if (userSubscriptions.value.length < 1) {
    await router.push('/');
    return;
  }

  document.getElementById('subscriptions-heading')?.focus();
};

const askUnsubscribe = (subscriptions: Subscription[]) => {
  if (loading.value) {
    return;
  }

  modalTitle.value = 'Désabonnement';
  subscriptionsToUnsubscribe.value = subscriptions;
  unsubscribeError.value = '';
  unsubscribeStatus.value = '';
  modalOpened.value = true;
};

const closeModal = () => {
  if (loading.value) {
    return;
  }

  modalOpened.value = false;
};

const modalActions = computed(() => [{
  label: 'Valider',
  disabled: loading.value,
  'aria-busy': loading.value ? 'true' : undefined,
  onClick: unsubscribe,
}, {
  label: 'Annuler',
  disabled: loading.value,
  onClick: closeModal,
  secondary: true,
}]);
</script>

<template>
  <div class="fr-container">
    <AppBreadcrumb :links="links" />
    <div v-if="userSubscriptions">
      <h1 id="subscriptions-heading" tabindex="-1">
        Abonnements
      </h1>
      <p
        id="unsubscribe-status"
        class="fr-sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {{ unsubscribeStatus }}
      </p>
      <h2>{{ route.query.email }}</h2>
      <div class="fr-grid-row fr-grid-row--gutters">
        <SubscriptionsCard
          v-for="subscription in userSubscriptions"
          :key="subscription.id"
          :loading="loading"
          :subscription="subscription"
          @unsubscribe="askUnsubscribe([subscription])"
        />
      </div>
      <div v-if="userSubscriptions.length > 1">
        <DsfrButton
          class="fr-mt-2w"
          label="Me désabonner de toutes les adresses"
          :disabled="loading"
          @click="askUnsubscribe(userSubscriptions)"
        />
      </div>
    </div>
  </div>
  <AccessibleModal
    :opened="modalOpened"
    :title="modalTitle"
    :icon="modalIcon"
    :actions="modalActions"
    @close="closeModal"
  >
    <p
      class="fr-sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {{ loading ? 'Désabonnement en cours.' : '' }}
    </p>
    <p
      id="unsubscribe-error"
      class="fr-error-text"
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      tabindex="-1"
    >
      {{ unsubscribeError }}
    </p>
    <p v-if="subscriptionsToUnsubscribe.length > 1">
      Voulez-vous vous désabonner de toutes les notifications de changement de
      restrictions pour vos
      <strong>{{ subscriptionsToUnsubscribe.length }} adresses</strong> ?
    </p>
    <p v-else-if="subscriptionsToUnsubscribe[0]">
      Voulez-vous vous désabonner des notifications de changement de
      restrictions pour l'adresse
      <strong>{{ subscriptionsToUnsubscribe[0].libelleLocalisation }}</strong>
      ?
    </p>
  </AccessibleModal>
</template>
