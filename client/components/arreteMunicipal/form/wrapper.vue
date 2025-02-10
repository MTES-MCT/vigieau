<script setup lang="ts">
import type { ArreteMunicipal } from '~/dto/arrete_municipal.dto';
import useVuelidate from '@vuelidate/core';
import { useAlertStore } from '~/stores/alert';
import { parsePhoneNumber } from 'libphonenumber-js';

const props = defineProps<{
  arreteMunicipal: ArreteMunicipal;
}>();

const router = useRouter();
const loading = ref(false);
const alertStore = useAlertStore();
const api = useApi();
const v$ = useVuelidate();

const askEditPublishArrete = async () => {
  await saveArrete();
};

const saveArrete = async () => {
  if (loading.value) {
    return;
  }
  v$.value.$validate();
  if (v$.value.$error) {
    showErrors(v$.value.$errors, 'Impossible de publier l\'arrêté municipal');
    return;
  }
  loading.value = true;

  const phoneNumber = parsePhoneNumber(props.arreteMunicipal.userPhone, 'FR');
  props.arreteMunicipal.userPhone = phoneNumber.formatInternational();
  
  const { data, error } = props.arreteMunicipal.id
    ? await api.arreteMunicipal.update(props.arreteMunicipal.id.toString(), props.arreteMunicipal)
    : await api.arreteMunicipal.create(props.arreteMunicipal);
  if (data.value?.id) {
    navigateTo('/arrete-municipal');
    alertStore.addAlert({
      description: props.arreteMunicipal.id ? 'Modification réussie' : 'Publication réussie',
      type: 'success',
    });
  }
  loading.value = false;
}

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
</script>

<template>
  <ArreteMunicipalFormGeneral
    ref="generalFormRef"
    :arreteMunicipal="arreteMunicipal" />

  <ul
    class="fr-btns-group--sticky fr-btns-group fr-btns-group--md fr-btns-group--inline-sm fr-btns-group--inline-md fr-btns-group--inline-lg fr-mt-4w">
    <li>
      <DsfrButton
        :label="arreteMunicipal.statut === 'a_valider' ? 'Publier' : 'Modifier'"
        :disabled="loading"
        :icon="loading ? { name: 'ri-loader-4-line', animation: 'spin' } : ''"
        :iconRight="true"
        data-cy="ArreteMunicipalFormPublishBtn"
        @click="askEditPublishArrete()"
      />
    </li>
    <li style="margin-left: auto;">
      <DsfrButton
        label="Retour à la liste"
        icon="ri-arrow-left-line"
        secondary
        @click="router.push('/arrete-municipal')"
      />
    </li>
  </ul>
</template>