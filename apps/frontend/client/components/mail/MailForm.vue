<script setup lang="ts">
import useVuelidate from '@vuelidate/core';
import { email, helpers, required, sameAs } from '@vuelidate/validators';
import { storeToRefs } from 'pinia';
import { computed, nextTick, reactive, ref } from 'vue';
import type { Address } from '~/client/dto/address.dto';
import { useAddressStore } from '../../store/address';
import { focusFirstInvalidField } from '../../utils/form-validation';

interface SubscriptionFormData {
  profil: string
  email: string
  idAdresse: string | null
  lon: number | null
  lat: number | null
  commune: string | null
  confirmSubscription: boolean
  typesEau: string[]
}

const props = defineProps({
  subscribing: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits<{
  subscribe: [form: SubscriptionFormData]
}>();

const addressStore = useAddressStore();
const { address, geo, profile } = storeToRefs(addressStore);
const { adressString } = addressStore;

const formElement = ref<HTMLFormElement | null>(null);
const submitButton = ref<HTMLButtonElement | null>(null);
const formData = reactive<SubscriptionFormData>({
  profil: profile.value || 'particulier',
  email: '',
  idAdresse: null,
  lon: null,
  lat: null,
  commune: null,
  confirmSubscription: false,
  typesEau: ['AEP', 'SUP', 'SOU'],
});

const typesEauOptions = [
  {
    id: 'subscription-water-aep',
    label: 'L’eau potable',
    value: 'AEP',
  },
  {
    id: 'subscription-water-sup',
    label: 'L’eau superficielle',
    value: 'SUP',
  },
  {
    id: 'subscription-water-sou',
    label: 'L’eau souterraine',
    value: 'SOU',
  },
];

const hasSelectedLocation = (): boolean => (
  typeof formData.lon === 'number'
  && typeof formData.lat === 'number'
  && Boolean(formData.idAdresse || formData.commune)
);

const rules = computed(() => ({
  email: {
    required: helpers.withMessage('L’adresse e-mail est obligatoire.', required),
    email: helpers.withMessage('L’adresse e-mail doit respecter le format nom@exemple.fr.', email),
  },
  profil: {
    required: helpers.withMessage('Le profil est obligatoire.', required),
  },
  confirmSubscription: {
    checked: helpers.withMessage(
      'L’acceptation de la politique de confidentialité est obligatoire.',
      sameAs(true),
    ),
  },
  lon: {
    selectedLocation: helpers.withMessage(
      'L’adresse ou le point sur la carte est obligatoire.',
      hasSelectedLocation,
    ),
  },
  typesEau: {
    required: helpers.withMessage('Au moins un type d’eau est obligatoire.', required),
  },
}));

const v$ = useVuelidate(rules, formData);

const firstErrorMessage = (validation: any): string => (
  String(validation.$errors[0]?.$message ?? '')
);
const profileError = computed(() => firstErrorMessage(v$.value.profil));
const waterTypesError = computed(() => firstErrorMessage(v$.value.typesEau));
const addressError = computed(() => firstErrorMessage(v$.value.lon));
const emailError = computed(() => firstErrorMessage(v$.value.email));
const consentError = computed(() => firstErrorMessage(v$.value.confirmSubscription));

const setAddress = (selectedAddress: Address | null) => {
  if (!selectedAddress || ['municipality'].includes(selectedAddress.properties.type)) {
    formData.idAdresse = null;
    formData.commune = null;
    formData.lon = null;
    formData.lat = null;
    return;
  }
  formData.idAdresse = selectedAddress.properties.id;
  formData.commune = null;
  formData.lon = selectedAddress.geometry.coordinates[0];
  formData.lat = selectedAddress.geometry.coordinates[1];
};

const selectPointOnMap = (event: any) => {
  formData.idAdresse = null;
  formData.commune = event.commune;
  formData.lon = event.lng;
  formData.lat = event.lat;
};

const invalidFieldIds = (): string[] => [
  v$.value.profil.$error ? 'subscription-profile-group-particulier' : '',
  v$.value.typesEau.$error ? typesEauOptions[0].id : '',
  v$.value.lon.$error ? 'subscription-address' : '',
  v$.value.email.$error ? 'subscription-email' : '',
  v$.value.confirmSubscription.$error ? 'subscription-consent' : '',
].filter(Boolean);

const submitForm = async () => {
  const isValid = await v$.value.$validate();
  if (!isValid) {
    await nextTick();
    focusFirstInvalidField(formElement.value, invalidFieldIds());
    return;
  }

  if (!props.subscribing) {
    emit('subscribe', formData);
  }
};

defineExpose({
  focus: () => submitButton.value?.focus(),
});
</script>

<template>
  <form
    ref="formElement"
    class="mail-form"
    data-cy="SubscriptionForm"
    novalidate
    :aria-busy="subscribing"
    @submit.prevent="submitForm"
  >
    <MixinsProfile
      :profile="formData.profil"
      class="fr-mb-2w"
      required
      group-id="subscription-profile-group"
      error-id="subscription-profile-error"
      :aria-invalid="Boolean(profileError)"
      :error-message="profileError"
      :disabled="subscribing"
      @profile-update="formData.profil = $event"
    />

    <fieldset
      id="subscription-water-types-group"
      class="fr-fieldset"
      :disabled="subscribing"
      :aria-invalid="waterTypesError ? 'true' : 'false'"
      :aria-describedby="waterTypesError ? 'subscription-water-types-error' : undefined"
    >
      <legend class="fr-fieldset__legend fr-text--regular">
        Je souhaite être informé par e-mail des changements de restrictions me concernant et portant sur :
        <span class="required"> (obligatoire)</span>
      </legend>
      <div
        v-for="option in typesEauOptions"
        :key="option.value"
        class="fr-fieldset__element"
      >
        <div class="fr-checkbox-group">
          <input
            :id="option.id"
            v-model="formData.typesEau"
            type="checkbox"
            name="typesEau"
            :value="option.value"
            :aria-invalid="waterTypesError ? 'true' : 'false'"
            :aria-describedby="waterTypesError ? 'subscription-water-types-error' : undefined"
          >
          <label
            class="fr-label"
            :for="option.id"
          >
            {{ option.label }}
          </label>
        </div>
      </div>
      <p
        v-if="waterTypesError"
        id="subscription-water-types-error"
        class="fr-error-text"
        role="alert"
      >
        {{ waterTypesError }}
      </p>
    </fieldset>

    <div
      class="fr-input-group"
      :class="{ 'fr-input-group--error': addressError }"
    >
      <MixinsSearchAddress
        id="subscription-address"
        :profile="formData.profil"
        :query="adressString()"
        :address="address"
        :geo="geo"
        :light="true"
        :disabled="subscribing"
        :exact-address="true"
        :aria-invalid="addressError ? 'true' : 'false'"
        :aria-describedby="addressError ? 'subscription-address-error' : undefined"
        required
        @search="setAddress($event.address)"
      />
      <p
        v-if="addressError"
        id="subscription-address-error"
        class="fr-error-text"
        role="alert"
      >
        {{ addressError }}
      </p>
    </div>

    <p
      class="divider"
      aria-hidden="true"
    >
      ou
    </p>

    <p>Sélectionnez un point sur la carte.</p>
    <MixinsMapPoint
      class="fr-mb-2w"
      :disabled="subscribing"
      @select-point="selectPointOnMap($event)"
    />

    <div
      class="fr-input-group fr-mt-2w"
      :class="{ 'fr-input-group--error': emailError }"
    >
      <label
        class="fr-label"
        for="subscription-email"
      >
        Entrez votre adresse e-mail
        <span class="required"> (obligatoire)</span>
      </label>
      <p
        id="subscription-email-hint"
        class="fr-hint-text"
      >
        Exemple : nom@exemple.fr
      </p>
      <input
        id="subscription-email"
        v-model="formData.email"
        class="fr-input"
        :class="{ 'fr-input--error': emailError }"
        type="email"
        name="email"
        autocomplete="email"
        required
        :disabled="subscribing"
        :aria-invalid="emailError ? 'true' : 'false'"
        :aria-describedby="emailError
          ? 'subscription-email-hint subscription-email-error'
          : 'subscription-email-hint'"
      >
      <p
        v-if="emailError"
        id="subscription-email-error"
        class="fr-error-text"
        role="alert"
      >
        {{ emailError }}
      </p>
    </div>

    <div
      class="fr-checkbox-group fr-mt-3w"
      :class="{ 'fr-checkbox-group--error': consentError }"
    >
      <input
        id="subscription-consent"
        v-model="formData.confirmSubscription"
        type="checkbox"
        name="confirmSubscription"
        required
        :disabled="subscribing"
        :aria-invalid="consentError ? 'true' : 'false'"
        :aria-describedby="consentError ? 'subscription-consent-error' : undefined"
      >
      <label
        class="fr-label"
        for="subscription-consent"
      >
        J’accepte de recevoir vos e-mails et confirme avoir pris connaissance de votre politique de confidentialité et
        mentions légales.
        <span class="required"> (obligatoire)</span>
      </label>
      <p
        v-if="consentError"
        id="subscription-consent-error"
        class="fr-error-text"
        role="alert"
      >
        {{ consentError }}
      </p>
    </div>

    <p>
      Les
      <router-link
        to="/donnees-personnelles"
        target="_blank"
        title="Données collectées (nouvelle fenêtre)"
      >
        données collectées
      </router-link>
      lors de votre inscription sont utilisées dans le cadre d’une mission de service public dont les responsables de
      traitement sont la Direction générale de l’Aménagement, du Logement et de la Nature (DGALN). Vous pouvez à tout
      moment vous opposer à ces traitements en vous désinscrivant en cliquant sur le lien présent dans nos e-mails.
    </p>

    <div class="text-align-right">
      <button
        ref="submitButton"
        class="fr-btn"
        type="submit"
        data-cy="SubscriptionSubmit"
        :disabled="subscribing"
      >
        Valider
      </button>
      <span
        class="fr-sr-only"
        role="status"
        aria-live="polite"
      >{{ subscribing ? 'Inscription en cours.' : '' }}</span>
      <Loader
        class="adresse-loader fr-ml-1w"
        :show="subscribing"
        :announce="false"
      />
    </div>
  </form>
</template>
