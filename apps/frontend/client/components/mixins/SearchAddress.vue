<script setup lang="ts">
import {
  computed,
  nextTick,
  ref,
  type Ref,
  useAttrs,
  watch,
} from 'vue';
import utils from '../../utils';
import api from '../../api';
import type { Address } from '../../dto/address.dto';
import type { Geo } from '~/client/dto/geo.dto';
import {
  ADDRESS_SEARCH_LOADING_STATUS,
  createLatestRequestGuard,
  getAddressSuggestionStatus,
} from '../../utils/address-combobox';

defineOptions({ inheritAttrs: false });

const props = defineProps({
  loading: {
    type: Boolean,
    default: false,
  },
  required: {
    type: Boolean,
    default: false,
  },
  query: {
    type: String,
    default: '',
  },
  address: {
    type: Object,
    default: null,
  },
  geo: {
    type: Object,
    default: null,
  },
  light: {
    type: Boolean,
    default: false,
  },
  showGeoloc: {
    type: Boolean,
    default: false,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  exactAddress: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits<{
  search: [{
    address: Address | null,
    geo: Geo | null,
  }]
}>();

const attrs = useAttrs();

const _closeModal = (): void => {
  modalOpened.value = false;
};

const addressQuery: Ref<string> = ref('');
const addresses: Ref<Address[]> = ref([]);
const loadAddresses: Ref<boolean> = ref(true);
const loadingAdresses: Ref<boolean> = ref(false);
const autoSelectAddress: Ref<boolean> = ref(false);
const addressSearchStatus: Ref<string> = ref('');
const modalOpened: Ref<boolean> = ref(false);
const modalActions: Ref<any[]> = ref([{ label: 'Recommencer', onClick: _closeModal }]);
const fdrAutocomplete: Ref<any> = ref(null);
const addressRequestGuard = createLatestRequestGuard();
const forwardedInputAttrs = computed(() => Object.fromEntries(
  Object.entries(attrs).filter(([name]) => !['class', 'profile', 'style'].includes(name)),
));

const focusAddressInput = async () => {
  await nextTick();
  fdrAutocomplete.value?.focusInput();
};

const selectAddress = (address: string | Address | null, geo: Geo | null = null) => {
  if (typeof address === 'string') {
    addressRequestGuard.cancel();
    autoSelectAddress.value = false;
    loadAddresses.value = true;
    addressQuery.value = address;
    addresses.value = [];
    emit('search', {
      address: null,
      geo: null,
    });
    if (address === '') {
      loadingAdresses.value = false;
      addressSearchStatus.value = '';
    } else {
      loadingAdresses.value = true;
      addressSearchStatus.value = ADDRESS_SEARCH_LOADING_STATUS;
    }
    return;
  }

  if (!address && !geo) {
    addressRequestGuard.cancel();
    autoSelectAddress.value = false;
    addresses.value = [];
    loadingAdresses.value = false;
    addressSearchStatus.value = '';
    emit('search', {
      address: null,
      geo: null,
    });
    return;
  }

  addressRequestGuard.cancel();
  autoSelectAddress.value = false;
  loadAddresses.value = false;
  loadingAdresses.value = false;
  addresses.value = [];
  addressQuery.value = address ? address.properties.label : geo!.nom;
  addressSearchStatus.value = `Adresse sélectionnée : ${addressQuery.value}.`;
  emit('search', {
    address,
    geo,
  });
};

const geoloc = () => {
  const geolocationRequestId = addressRequestGuard.cancel();
  autoSelectAddress.value = false;
  loadAddresses.value = false;
  addresses.value = [];
  loadingAdresses.value = false;
  addressSearchStatus.value = 'Géolocalisation en cours.';

  const successCallback = async (position) => {
    let shouldRestoreFocus = false;

    try {
      const { data, error } = await api.searchGeoByLatlon(
        position.coords.longitude,
        position.coords.latitude,
      );

      if (!addressRequestGuard.isCurrent(geolocationRequestId)) {
        return;
      }

      shouldRestoreFocus = true;
      const geo = data.value?.[0];

      if (error.value || !geo) {
        addressSearchStatus.value = 'La géolocalisation n’a pas permis d’identifier votre commune. Vous pouvez saisir votre adresse.';
        return;
      }

      selectAddress(null, geo);
      addressSearchStatus.value = `Position localisée : ${geo.nom}.`;
    } catch {
      if (addressRequestGuard.isCurrent(geolocationRequestId)) {
        shouldRestoreFocus = true;
        addressSearchStatus.value = 'La géolocalisation a échoué. Vous pouvez saisir votre adresse.';
      }
    } finally {
      if (shouldRestoreFocus) {
        await focusAddressInput();
      }
    }
  };

  const errorCallback = () => {
    if (!addressRequestGuard.isCurrent(geolocationRequestId)) {
      return;
    }
    addressSearchStatus.value = 'La géolocalisation a échoué. Vous pouvez saisir votre adresse.';
    void focusAddressInput();
  };

  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    errorCallback();
    return;
  }

  try {
    navigator.geolocation.getCurrentPosition(
      successCallback,
      errorCallback,
      { timeout: 10_000 },
    );
  } catch {
    errorCallback();
  }
};

if (props.address || props.geo) {
  if (!props.exactAddress || (props.address && props.address.properties.type === 'housenumber')) {
    addressQuery.value = props.address ? props.address.properties.label : props.geo.nom;
    selectAddress(props.address, props.geo);
  }
}

watch(addressQuery, utils.debounce(async () => {
  if (!addressQuery.value || !loadAddresses.value) {
    loadAddresses.value = true;
    addresses.value = [];
    loadingAdresses.value = false;
    return;
  }

  const searchedQuery = addressQuery.value;
  const requestId = addressRequestGuard.next();
  loadingAdresses.value = true;
  addressSearchStatus.value = ADDRESS_SEARCH_LOADING_STATUS;

  try {
    const { data: response, error } = await api.searchAddresses(
      searchedQuery,
      props.exactAddress,
    );

    if (
      !addressRequestGuard.isCurrent(requestId)
      || addressQuery.value !== searchedQuery
    ) {
      return;
    }

    if (error.value) {
      addresses.value = [];
      autoSelectAddress.value = false;
      addressSearchStatus.value = 'La recherche d’adresses a échoué. Vous pouvez réessayer dans quelques instants.';
      return;
    }

    addresses.value = response.value?.features ?? [];
    addressSearchStatus.value = getAddressSuggestionStatus(addresses.value.length);

    if (autoSelectAddress.value) {
      autoSelectAddress.value = false;
      if (addresses.value[0]) {
        selectAddress(addresses.value[0]);
      }
    }
  } catch {
    if (addressRequestGuard.isCurrent(requestId)) {
      addresses.value = [];
      autoSelectAddress.value = false;
      addressSearchStatus.value = 'La recherche d’adresses a échoué. Vous pouvez réessayer dans quelques instants.';
    }
  } finally {
    if (addressRequestGuard.isCurrent(requestId)) {
      loadingAdresses.value = false;
    }
  }
}, 500));


if (props.query && !props.address && !props.geo) {
  autoSelectAddress.value = true;
  addressQuery.value = props.query;
  loadingAdresses.value = true;
  addressSearchStatus.value = ADDRESS_SEARCH_LOADING_STATUS;
}
</script>

<template>
  <div
    class="search"
    :class="[{ light }, $attrs.class]"
    :style="$attrs.style"
  >
    <div class="autocomplete-wrapper fr-grid-row fr-grid-row--bottom">
      <FdrAutoComplete
        ref="fdrAutocomplete"
        v-bind="forwardedInputAttrs"
        placeholder="Ex: 20 avenue de Ségur, 75007, Paris"
        :model-value="addressQuery"
        :options="addresses"
        :status-message="addressSearchStatus"
        label="Entrez votre adresse complète"
        display-key="properties.label"
        data-cy="AddressSearchInput"
        :light="light"
        :disabled="disabled"
        :required="required"
        aria-label-list="Liste d’adresses"
        @update:model-value="selectAddress($event)"
        @search="selectAddress($event)"
      />
      <Loader
        class="adresse-loader"
        :show="loadingAdresses || loading"
      />
      <DsfrButton
        v-if="showGeoloc"
        class="fr-ml-1w"
        type="button"
        data-cy="GeolocationButton"
        label="Me géolocaliser"
        aria-label="Me géolocaliser"
        icon-only
        icon="ri-map-pin-user-line"
        tertiary
        :disabled="disabled"
        :aria-disabled="disabled"
        @click="geoloc()"
      />
    </div>
  </div>
  <DsfrNotice
    v-if="!light"
    title="Nous ne conservons pas vos données et votre adresse"
    class="notice-light fr-mt-1w"
  />
  <DsfrModal
    :opened="modalOpened"
    title="Cela n'a pas fonctionné comme prévu !"
    icon="ri-arrow-right-line"
    :actions="modalActions"
    @close="_closeModal"
  >
    <div>
      Nous sommes désolés, une erreur s’est glissée dans notre système et nous n’avons pas pu traiter correctement votre
      requête
    </div>
  </DsfrModal>
</template>

<style scoped lang="scss">
.autocomplete-wrapper {
  position: relative;

  .adresse-loader {
    position: absolute;
    bottom: 8px;
    left: 0;
  }

  .search-autocomplete {
    flex: 1;
    min-width: 0;
  }
}
</style>
