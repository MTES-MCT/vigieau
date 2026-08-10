<script setup lang="ts">
import { nextTick, type Ref } from 'vue';
import type { ZonePublicationPin } from '../../api';
import utils from '../../utils';
import type { Address } from '../../dto/address.dto';
import type { Geo } from '~/client/dto/geo.dto';
import { focusFirstInvalidField } from '../../utils/form-validation';
import { storeToRefs } from 'pinia';
import { useAddressStore } from '../../store/address';
import { helpers, required, requiredIf } from '@vuelidate/validators';
import useVuelidate from '@vuelidate/core';

const props = defineProps<{
  pointSelected?: unknown;
  publicationPin?: ZonePublicationPin;
}>();

const emit = defineEmits<{
  formData: any;
}>();

const addressStore = useAddressStore();
const router = useRouter();
const route = useRoute();
const { profile, typeEau } = storeToRefs(addressStore);
const profileOptions = [
  {
    value: 'particulier',
    text: 'Un particulier',
  },
  {
    value: 'entreprise',
    text: 'Un professionnel',
  },
  {
    value: 'collectivite',
    text: 'Une collectivité',
  },
  {
    value: 'exploitation',
    text: 'Une exploitation agricole',
  },
];
const typeEauOptions = [
  {
    text: 'Du robinet',
    value: 'AEP',
  },
  {
    text: `Des cours d'eau, rivières`,
    value: 'SUP',
  },
  {
    text: `Des nappes (puits ou forage)`,
    value: 'SOU',
  },
];

const modalOpened: Ref<boolean> = ref(false);
const modalTitle: Ref<string> = ref('');
const modalText: Ref<string> = ref('');
const modalIcon: Ref<string> = ref('');
const modalActions: Ref<any[]> = ref([]);
const loading = ref(false);
const query = ref('');
const address = typeof route.query.adresse === 'string'
  ? route.query.adresse
  : null;
if (address) {
  query.value = address;
}

const formData = reactive({
  profil: ref(profile.value),
  address: null,
  geo: null,
  typeEau: ref(typeEau.value),
});
const rules = computed(() => {
  return {
    profil: {
      required: helpers.withMessage('Le profil est obligatoire.', required),
    },
    typeEau: {
      required: helpers.withMessage("Le type d'eau est obligatoire.", required),
    },
    address: {
      requiredIf: requiredIf(!formData.geo),
    },
    geo: {
      requiredIf: requiredIf(!formData.address),
    },
  };
});

const v$ = useVuelidate(rules, formData);

const profileErrorMessage = computed(() => (
  v$.value.profil.$errors[0]?.$message?.toString() ?? ''
));
const typeEauErrorMessage = computed(() => (
  v$.value.typeEau.$errors[0]?.$message?.toString() ?? ''
));
const addressErrorMessage = computed(() => (
  v$.value.address.$dirty
  && v$.value.geo.$dirty
  && !formData.address
  && !formData.geo
    ? 'L’adresse ou la géolocalisation est obligatoire.'
    : ''
));

const searchZone = async () => {
  if (loading.value) {
    return;
  }

  await v$.value.$validate();
  if (v$.value.$error) {
    await nextTick();
    focusFirstInvalidField(document, [
      ...(v$.value.profil.$invalid ? ['main-search-profile'] : []),
      ...(v$.value.typeEau.$invalid ? ['main-search-water-type'] : []),
      ...(addressErrorMessage.value ? ['main-search-address'] : []),
    ]);
    return;
  }

  await utils.searchZones(
    formData.address,
    formData.geo,
    formData.profil,
    formData.typeEau,
    router,
    modalTitle,
    modalText,
    modalIcon,
    modalActions,
    modalOpened,
    loading,
    props.publicationPin,
  );
};

const setAddress = (address: Address | null, geo: Geo | null) => {
  formData.address = address;
  formData.geo = geo;
};

const closeModal = (): void => {
  modalOpened.value = false;
};
</script>

<template>
  <form
    class="search"
    data-cy="MainRestrictionSearchForm"
    novalidate
    :aria-busy="loading"
    @submit.prevent="searchZone"
  >
    <div>
      <DsfrInputGroup
        description-id="main-search-profile-error"
        :error-message="profileErrorMessage"
      >
        <DsfrSelect
          v-model="formData.profil"
          label="Choisissez votre profil de consommateur d’eau"
          select-id="main-search-profile"
          data-cy="MainSearchProfile"
          :options="profileOptions"
          required
          :aria-invalid="profileErrorMessage ? 'true' : undefined"
          :aria-describedby="profileErrorMessage ? 'main-search-profile-error' : undefined"
          @update:model-value="emit('formData', formData)"
        >
          <template #required-tip>
            <span class="required-marker"> (obligatoire)</span>
          </template>
        </DsfrSelect>
      </DsfrInputGroup>
    </div>
    <div>
      <DsfrInputGroup
        description-id="main-search-water-type-error"
        :error-message="typeEauErrorMessage"
      >
        <DsfrSelect
          v-model="formData.typeEau"
          label="Choisissez le type d’eau que vous consommez"
          select-id="main-search-water-type"
          data-cy="MainSearchWaterType"
          :options="typeEauOptions"
          required
          :aria-invalid="typeEauErrorMessage ? 'true' : undefined"
          :aria-describedby="typeEauErrorMessage ? 'main-search-water-type-error' : undefined"
          @update:model-value="emit('formData', formData)"
        >
          <template #required-tip>
            <span class="required-marker"> (obligatoire)</span>
          </template>
        </DsfrSelect>
      </DsfrInputGroup>
    </div>
    <div>
      <p class="fr-mb-0">
        Cliquez sur la carte pour indiquer où se situe votre
        {{
          formData.profil === 'particulier' ? 'adresse' : 'point de prélèvement'
        }}
      </p>
    </div>
    <div class="divider fr-my-1w">
      ou
    </div>
    <div>
      <DsfrInputGroup
        description-id="main-search-address-error"
        :error-message="addressErrorMessage"
      >
        <MixinsSearchAddress
          id="main-search-address"
          :required="true"
          :query="query"
          :light="true"
          :show-geoloc="true"
          :loading="loading"
          :aria-invalid="addressErrorMessage ? 'true' : undefined"
          :aria-describedby="addressErrorMessage ? 'main-search-address-error' : undefined"
          @search="setAddress($event.address, $event.geo)"
        />
      </DsfrInputGroup>
    </div>
    <div class="fr-mt-2w">
      <DsfrButton
        type="submit"
        data-cy="MainRestrictionSearchSubmit"
        :disabled="loading"
        :aria-disabled="loading"
      >
        Je consulte les restrictions
      </DsfrButton>
    </div>
  </form>

  <DsfrModal
    :opened="modalOpened"
    :title="modalTitle"
    :icon="modalIcon"
    :actions="modalActions"
    @close="closeModal"
  >
    <p>{{ modalText }}</p>
  </DsfrModal>
</template>
