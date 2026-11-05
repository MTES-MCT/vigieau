<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import api from '../../api';
import type { Subscription } from '../../dto/subscription.dto';
import { getHttpErrorStatus } from '../../utils/zone-publication';
import { isPreprodAuthenticationError } from '../../utils/preprod-auth';

definePageMeta({
  layout: 'basic',
});

useHead({
  title: `Abonnements - ${useRuntimeConfig().public.appName}`,
  meta: [{ name: 'referrer', content: 'no-referrer' }],
});

const links = [{ to: '/', text: 'Accueil' }, { text: 'Abonnements' }];
const loading = ref(false);
const modalOpened = ref(false);
const subscriptionsToUnsubscribe = ref<Subscription[]>([]);
const unsubscribeError = ref('');
const unsubscribeStatus = ref('');
const userSubscriptions = ref<Subscription[]>([]);
const accessState = ref<'loading' | 'ready' | 'link-required' | 'unavailable'>('loading');
const recoveryEmail = ref('');
const recoveryPending = ref(false);
const recoveryError = ref('');
const recoveryEmailInvalid = ref(false);
const recoveryStatus = ref('');
const recoveryEmailInput = ref<HTMLInputElement | null>(null);
const route = useRoute();
const token = computed(() => typeof route.query.token === 'string' ? route.query.token : '');
let loadVersion = 0;

const loadSubscriptions = async () => {
  const version = ++loadVersion;
  userSubscriptions.value = [];
  unsubscribeStatus.value = '';
  modalOpened.value = false;
  if (!token.value) {
    accessState.value = 'link-required';
    return;
  }

  accessState.value = 'loading';
  try {
    const { data, error } = await api.getUserSubscriptions(token.value);
    if (version !== loadVersion) return;
    if (error.value) throw error.value;
    if (!Array.isArray(data.value)) throw new Error('Invalid subscriptions response');
    userSubscriptions.value = data.value;
    accessState.value = 'ready';
  } catch (error) {
    if (version !== loadVersion) return;
    accessState.value = !isPreprodAuthenticationError(error)
      && [401, 403].includes(getHttpErrorStatus(error) ?? 0)
      ? 'link-required'
      : 'unavailable';
  }
};

watch(token, loadSubscriptions, { immediate: true });

const requestManagementLink = async () => {
  if (recoveryPending.value) return;
  recoveryError.value = '';
  recoveryEmailInvalid.value = false;
  recoveryStatus.value = '';
  recoveryEmail.value = recoveryEmail.value.trim();
  if (!recoveryEmailInput.value?.checkValidity()) {
    recoveryEmailInvalid.value = true;
    recoveryError.value = 'Saisissez une adresse e-mail au format nom@exemple.fr.';
    await nextTick();
    recoveryEmailInput.value?.focus();
    return;
  }

  recoveryPending.value = true;
  try {
    const { error } = await api.requestSubscriptionManagementLink(recoveryEmail.value);
    if (error.value) throw error.value;
    recoveryStatus.value = 'Si cette adresse e-mail possède des abonnements, un nouveau lien de gestion vient de lui être envoyé. Vérifiez également vos courriers indésirables.';
  } catch (error) {
    const status = getHttpErrorStatus(error);
    recoveryEmailInvalid.value = status === 400;
    recoveryError.value = status === 429
      ? 'Trop de demandes ont été effectuées. Patientez quelques minutes avant de réessayer.'
      : status === 400
        ? 'Saisissez une adresse e-mail au format nom@exemple.fr.'
        : 'L’envoi du lien est momentanément indisponible. Veuillez réessayer dans quelques instants.';
  } finally {
    recoveryPending.value = false;
  }
  await nextTick();
  document.getElementById(recoveryError.value ? 'management-link-error' : 'management-link-status')?.focus();
};

const unsubscribe = async () => {
  if (loading.value) return;
  const ids = subscriptionsToUnsubscribe.value.map(subscription => subscription.id);
  if (ids.length < 1) return;

  loading.value = true;
  unsubscribeError.value = '';
  unsubscribeStatus.value = '';
  try {
    const response = ids.length > 1
      ? await api.unsubscribeAll(token.value)
      : await api.unsubscribe(ids[0], token.value);
    if (response.error?.value) throw response.error.value;
  } catch (error) {
    if (!isPreprodAuthenticationError(error)
      && [401, 403].includes(getHttpErrorStatus(error) ?? 0)) {
      accessState.value = 'link-required';
      userSubscriptions.value = [];
      modalOpened.value = false;
      await nextTick();
      recoveryEmailInput.value?.focus();
    } else {
      unsubscribeError.value = 'Le désabonnement n’a pas pu être effectué. Veuillez réessayer.';
      await nextTick();
      document.getElementById('unsubscribe-error')?.focus();
    }
    return;
  } finally {
    loading.value = false;
  }

  userSubscriptions.value = userSubscriptions.value.filter(subscription => !ids.includes(subscription.id));
  unsubscribeStatus.value = ids.length > 1
    ? 'Désabonnement de toutes les adresses effectué.'
    : 'Désabonnement de l’adresse effectué.';
  modalOpened.value = false;
  await nextTick();
  document.getElementById('unsubscribe-status')?.focus();
};

const askUnsubscribe = (subscriptions: Subscription[]) => {
  if (loading.value) return;
  subscriptionsToUnsubscribe.value = subscriptions;
  unsubscribeError.value = '';
  unsubscribeStatus.value = '';
  modalOpened.value = true;
};

const closeModal = () => {
  if (!loading.value) modalOpened.value = false;
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
    <h1 id="subscriptions-heading" tabindex="-1">
      Abonnements
    </h1>
    <p v-if="accessState === 'loading'" role="status">
      Chargement des abonnements…
    </p>
    <div v-else-if="accessState === 'link-required'">
      <h2>Recevoir un lien de gestion</h2>
      <p v-if="token" role="status">
        Ce lien de gestion est expiré ou invalide. Les liens sont valables pendant sept jours.
        Demandez un nouveau lien pour consulter vos abonnements ou vous désabonner.
      </p>
      <p v-else>
        Saisissez l’adresse e-mail utilisée lors de votre inscription pour recevoir un lien permettant
        de consulter vos abonnements ou de vous désabonner.
      </p>
      <form novalidate :aria-busy="recoveryPending" @submit.prevent="requestManagementLink">
        <div class="fr-input-group">
          <label class="fr-label" for="management-link-email">Adresse e-mail (obligatoire)</label>
          <p id="management-link-email-hint" class="fr-hint-text">
            Format attendu : nom@exemple.fr.
          </p>
          <input
            id="management-link-email"
            ref="recoveryEmailInput"
            v-model="recoveryEmail"
            class="fr-input"
            name="email"
            type="email"
            autocomplete="email"
            required
            maxlength="254"
            :disabled="recoveryPending"
            :aria-invalid="recoveryEmailInvalid ? 'true' : undefined"
            :aria-describedby="recoveryError ? 'management-link-email-hint management-link-error' : 'management-link-email-hint'"
            @input="recoveryEmailInvalid = false"
          >
        </div>
        <button class="fr-btn" type="submit" :disabled="recoveryPending">
          {{ recoveryPending ? 'Envoi en cours…' : 'Recevoir un nouveau lien' }}
        </button>
        <p id="management-link-error" class="fr-error-text fr-mt-2w" role="alert" tabindex="-1">
          {{ recoveryError }}
        </p>
        <p id="management-link-status" class="fr-mt-2w" role="status" tabindex="-1">
          {{ recoveryStatus }}
        </p>
      </form>
    </div>
    <div v-else-if="accessState === 'unavailable'">
      <p role="alert">
        Vos abonnements ne peuvent pas être chargés pour le moment. Veuillez réessayer dans quelques instants.
      </p>
      <DsfrButton label="Réessayer" @click="loadSubscriptions" />
    </div>
    <div v-else>
      <p id="unsubscribe-status" role="status" aria-live="polite" aria-atomic="true" tabindex="-1">
        {{ unsubscribeStatus }}
      </p>
      <p v-if="userSubscriptions.length === 0">
        Vous n’avez plus d’abonnement aux alertes VigiEau.
      </p>
      <div v-else class="fr-grid-row fr-grid-row--gutters">
        <SubscriptionsCard
          v-for="subscription in userSubscriptions"
          :key="subscription.id"
          :loading="loading"
          :subscription="subscription"
          @unsubscribe="askUnsubscribe([subscription])"
        />
      </div>
      <DsfrButton
        v-if="userSubscriptions.length > 1"
        class="fr-mt-2w"
        label="Me désabonner de toutes les adresses"
        :disabled="loading"
        @click="askUnsubscribe(userSubscriptions)"
      />
      <p class="fr-mt-3w">
        <NuxtLink to="/abonnements/nouveau">
          Ajouter une nouvelle adresse
        </NuxtLink>
      </p>
    </div>
  </div>
  <AccessibleModal
    :opened="modalOpened"
    title="Désabonnement"
    :actions="modalActions"
    @close="closeModal"
  >
    <p class="fr-sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ loading ? 'Désabonnement en cours.' : '' }}
    </p>
    <p id="unsubscribe-error" class="fr-error-text" role="alert" aria-live="assertive" aria-atomic="true" tabindex="-1">
      {{ unsubscribeError }}
    </p>
    <p v-if="subscriptionsToUnsubscribe.length > 1">
      Voulez-vous vous désabonner de toutes les notifications de changement de
      restrictions pour vos <strong>{{ subscriptionsToUnsubscribe.length }} adresses</strong> ?
    </p>
    <p v-else-if="subscriptionsToUnsubscribe[0]">
      Voulez-vous vous désabonner des notifications de changement de restrictions pour l'adresse
      <strong>{{ subscriptionsToUnsubscribe[0].libelleLocalisation }}</strong> ?
    </p>
  </AccessibleModal>
</template>
