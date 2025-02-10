<script setup lang="ts">
import type { Ref } from "vue";
import { ArreteCadre } from "~/dto/arrete_cadre.dto";
import { useAuthStore } from "~/stores/auth";

const route = useRoute();
const api = useApi();
const router = useRouter();
const utils = useUtils();
const authStore = useAuthStore();

const arreteCadre: Ref<ArreteCadre> = ref();
const { data, error } = await api.arreteCadre.get(<string>route.params.id);
if (data.value) {
  arreteCadre.value = <ArreteCadre>data.value;
}

const isAcOnDepartementUser: boolean =
  authStore.isMte || arreteCadre.value.departements.some((d) => authStore.user?.roleDepartements.includes(d.code));
const isZaOutdated: boolean = arreteCadre.value.statut !== 'abroge' && arreteCadre.value.zonesAlerte.some((za) => za.disabled);

const consultationButtons: Ref<any[]> = ref([
  {
    label: 'Retour à la liste',
    icon: "ri-arrow-left-line",
    secondary: true,
    onclick: () => {
      router.push('/arrete-cadre');
    },
  },
]);

if(authStore.isMte || (arreteCadre.value.statut !== 'abroge' && isAcOnDepartementUser && !isZaOutdated)) {
  consultationButtons.value.push({
      label: 'Corriger',
      icon: 'ri-edit-2-fill',
      secondary: true,
      onclick: () => {
        utils.askEditArreteCadre(arreteCadre.value, modalTitle, modalDescription, modalActions, modalOpened, editArreteCadre);
      },
    })
}

const editArreteCadre = (id: string) => {
  utils.closeModal(modalOpened);
  navigateTo(`/arrete-cadre/${id}/edition`);
};

const modalOpened: Ref<boolean> = ref(false);
const modalTitle: Ref<string> = ref('');
const modalDescription: Ref<string> = ref('');
const modalActions: Ref<any[]> = ref([]);
</script>

<template>
  <template v-if="arreteCadre">
    <h1>Arrêté cadre&nbsp;: {{ arreteCadre.numero }} <MixinsStatutBadge :statut="arreteCadre.statut" /></h1>
    
    
    <ArreteCadreConsultationGeneral :arreteCadre="arreteCadre" />
      
    <ArreteCadreConsultationZones :arreteCadre="arreteCadre" />
    
    <h2>Usages et mesures de restriction</h2>
    <ArreteCadreFormRecapitulatif :arrete-cadre="arreteCadre" :viewOnly="true" />

    <DsfrButtonGroup :buttons="consultationButtons"
                     class="fr-mt-2w fr-btns-group--sticky"
                     align="right"
                     inlineLayoutWhen="always" />
    
    <DsfrModal :opened="modalOpened" 
               icon="ri-arrow-right-line"
               :title="modalTitle"
               :actions="modalActions"
               @close="modalOpened = utils.closeModal(modalOpened);">
      <div v-html="modalDescription"></div>
    </DsfrModal>
  </template>
</template>