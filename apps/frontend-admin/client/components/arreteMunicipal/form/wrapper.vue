<script setup lang="ts">
import type { ArreteMunicipal } from '~/dto/arrete_municipal.dto';
import useVuelidate from '@vuelidate/core';
import { useAlertStore } from '~/stores/alert';
import { parsePhoneNumberWithError } from 'libphonenumber-js';

const props = defineProps<{
  arreteMunicipal: ArreteMunicipal;
}>();

const router = useRouter();
const loading = ref(false);
const alertStore = useAlertStore();
const api = useApi();
const v$ = useVuelidate();
const modalOpened = ref(false);
const utils = useUtils();

const askEditPublishArrete = async () => {
  await checkSaveArrete();
};

const checkSaveArrete = async () => {
  if (loading.value) {
    return;
  }
  v$.value.$validate();
  if (v$.value.$error) {
    showErrors(v$.value.$errors, 'Impossible de publier l\'arrêté municipal');
    return;
  }
  loading.value = true;

  // Check si l'arrêté municipal sera visible sur VigiEau
  const toSave = await checkVisibilityOnVigiEau();

  if (toSave) {
    await saveArrete();
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

const checkVisibilityOnVigiEau = async () => {
  const { data, error } = await api.vigiEau.getZonesByCommune(props.arreteMunicipal.communes[0]?.code);
  if ((data.value && data.value.length > 0) || (error?.value && error.value.statusCode === 409)) {
    return true;
  }
  modalOpened.value = true;
  return false;
};

const saveArrete = async () => {
  const phoneNumber = parsePhoneNumberWithError(props.arreteMunicipal.userPhone, 'FR');
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
  <MixinsConfirmationModal
    :opened="modalOpened"
    title="Visibilité de l'arrêté municipal sur VigiEau"
    description="Aucun arrêté préfectoral n'est en vigueur sur cette commune. Vous pouvez tout de même créer l'arrêté municipal mais celui-ci ne sera pas visible sur VigiEau."
    @close="modalOpened = utils.closeModal(modalOpened)"
    @confirm="saveArrete()"
  />
</template>