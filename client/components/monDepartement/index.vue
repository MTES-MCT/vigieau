<script setup lang="ts">
import { useAlertStore } from "~/stores/alert";
import { useAuthStore } from "~/stores/auth";
import { Parametres } from "~/dto/parametres.dto";
import type { Ref } from "vue";
import { useRefDataStore } from "~/stores/refData";

const api = useApi();
const loading = ref(false);
const departementFormRef = ref(null);
const alertStore = useAlertStore();
const parametres: Ref<Parametres[] | undefined> = ref();
const parametresSelected: Ref<Parametres | undefined> = ref();
const authStore = useAuthStore();
const depSelected = ref(authStore.user?.role === 'departement' ? authStore.user.roleDepartements[0] : null);
const departementsOptions: Ref<any[] | undefined> = ref();
const refDataStore = useRefDataStore();

const saveParams = async () => {
  if (loading.value) {
    return;
  }
  departementFormRef.value?.v$.$validate();
  if(departementFormRef.value?.v$.$error) {
    return;
  }
  loading.value = true;
  const { data, error } = await api.parametres.save(parametresSelected.value, depSelected.value);
  if(data.value) {
    alertStore.addAlert({
      description: 'Mise à jour des paramètres réussie',
      type: 'success',
    });
  }
  
  loading.value = false;
}

const loadParametres = async () => {
  const { data, error } = await api.parametres.list();
  if(data.value) {
    parametres.value = data.value;
    if(depSelected.value) {
      parametresSelected.value = findParametres(depSelected.value);
    }
  }
};

const findParametres = (depCode: string) => {
  const p = parametres.value?.find(p => p.departement.code === depCode);
  if(!p) {
    return new Parametres();
  }
  return parametres.value?.find(p => p.departement.code === depCode);
};

loadParametres();

watch(
  () => refDataStore.departements,
  () => {
    if (refDataStore.departements && refDataStore.departements.length > 0) {
      departementsOptions.value = refDataStore.departements
        .filter(d => authStore.user?.role === 'mte' || authStore.user?.roleDepartements.includes(d.code))
        .map((d) => {
        return {
          value: d.code,
          text: `${d.code} - ${d.nom}`,
        };
      });
    }
  },
  { immediate: true },
);

watch(depSelected, () => {
  if(depSelected.value) {
    parametresSelected.value = findParametres(depSelected.value);
  }
});
</script>

<template>
  <DsfrSelect
    v-model="depSelected"
    data-cy="ArreteRestrictionListDepartementSelect"
    label="Filtrer par Département"
    :options="departementsOptions"
  />
  <MonDepartementRegles v-if="parametresSelected"
                        :parametres="parametresSelected"
                        ref="departementFormRef"/>
  <DsfrButton
    :label="'Enregistrer'"
    data-cy="MonDepartementFormSaveBtn"
    :secondary="true"
    :icon="loading ? { name: 'ri-settings-3-line', animation: 'spin' } : 'ri-settings-3-line'"
    :disabled="loading"
    @click="saveParams()"
  />
</template>