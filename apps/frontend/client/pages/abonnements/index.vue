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
const modalActions: Ref<any[]> = ref([]);
const subscriptionsToUnsubscribe: Ref<Subscription[]> = ref([]);

const router = useRouter();
const route = useRoute();
const { data: userSubscriptions, error } = await api.getUserSubscriptions(route.query.token);

if (!userSubscriptions.value || userSubscriptions.value.length < 1 || error.value) {
  router.push('/');
}

const unsubscribe = async (ids: string[]) => {
  loading.value = true;
  const { error } = ids.length > 1
    ? await api.unsubscribeAll(route.query.token)
    : await api.unsubscribe(ids[0], route.query.token);
  if (!error.value) {
    userSubscriptions.value = userSubscriptions.value.filter(s => !ids.includes(s.id));
  }
  loading.value = false;
  closeModal();
};

const askUnsubscribe = (subscriptions: Subscription[]) => {
  modalTitle.value = 'Désabonnement';
  subscriptionsToUnsubscribe.value = subscriptions;
  modalActions.value = [{
    label: 'Valider',
    onClick: unsubscribe.bind(this, subscriptions.map(s => s.id)),
  }, { label: 'Annuler', onClick: closeModal, secondary: true }];
  modalOpened.value = true;
};

const closeModal = () => {
  modalOpened.value = false;
  if (userSubscriptions.value.length < 1) {
    router.push('/');
  }
};
</script>

<template>
  <div class="fr-container">
    <AppBreadcrumb :links="links" />
    <div v-if="userSubscriptions">
      <h1>Abonnements</h1>
      <h2>{{ route.query.email }}</h2>
      <div class="fr-grid-row fr-grid-row--gutters">
        <SubscriptionsCard v-for="subscription in userSubscriptions"
                           :key="subscription.id"
                           :loading="loading"
                           :subscription="subscription"
                           @unsubscribe="askUnsubscribe([subscription])" />
      </div>
      <div v-if="userSubscriptions.length > 1">
        <DsfrButton class="fr-mt-2w"
                    label="Me désabonner de toutes les adresses"
                    :disabled="loading"
                    @click="askUnsubscribe(userSubscriptions)" />
      </div>
    </div>
  </div>
  <DsfrModal :opened="modalOpened"
             :title="modalTitle"
             :icon="modalIcon"
             :actions="modalActions"
             @close="closeModal">
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
  </DsfrModal>
</template>
