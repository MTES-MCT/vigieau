<script setup lang="ts">
import type { Ref } from 'vue';
import type { ArreteRestriction } from '~/dto/arrete_restriction.dto';
import { useAuthStore } from '~/stores/auth';

const route = useRoute();
const api = useApi();
const router = useRouter();
const utils = useUtils();
const authStore = useAuthStore();

const arreteRestriction: Ref<ArreteRestriction> = ref();
const { data, error } = await api.arreteRestriction.get(<string>route.params.id);
if (data.value) {
  arreteRestriction.value = <ArreteRestriction>data.value;
  arreteRestriction.value.restrictions.map((r) => {
    if (!r.zoneAlerte) {
      r.isAep = true;
    }
    return r;
  });
}

const isArOnDepartementUser: boolean = authStore.isMte || authStore.user?.roleDepartements.includes(arreteRestriction.value.departement?.code);
const isZaOutdated: boolean = arreteRestriction.value.statut !== 'abroge' && arreteRestriction.value.restrictions.some((r) => r.zoneAlerte?.disabled);

const consultationButtons: Ref<any[]> = ref([
  {
    label: 'Retour à la liste',
    icon: 'ri-arrow-left-line',
    secondary: true,
    onclick: () => {
      router.push('/arrete-restriction');
    },
  },
]);

if (authStore.isMte || (arreteRestriction.value.statut !== 'abroge' && isArOnDepartementUser && !isZaOutdated)) {
  consultationButtons.value.push({
    label: 'Corriger',
    icon: 'ri-edit-2-fill',
    secondary: true,
    onclick: () => {
      utils.askEditArreteRestriction(arreteRestriction.value, modalTitle, modalDescription, modalActions, modalOpened, editArreteRestriction);
    },
  });
}

const editArreteRestriction = (id: string) => {
  utils.closeModal(modalOpened);
  navigateTo(`/arrete-restriction/${id}/edition`);
};

const modalOpened: Ref<boolean> = ref(false);
const modalTitle: Ref<string> = ref('');
const modalDescription: Ref<string> = ref('');
const modalActions: Ref<any[]> = ref([]);
</script>

<template>
  <template v-if="arreteRestriction">
    <h1>Arrêté de restriction&nbsp;: {{ arreteRestriction.numero }}
      <MixinsStatutBadge :statut="arreteRestriction.statut" />
    </h1>

    <div class="fr-grid-row fr-grid-row--gutters">
      <div class="fr-col-12 fr-col-lg-6">
        <ArreteRestrictionConsultationGeneral :arreteRestriction="arreteRestriction" />
        <ArreteRestrictionConsultationZones :arreteRestriction="arreteRestriction" />
      </div>
      <div class="fr-col-12 fr-col-lg-6">
        <ArreteRestrictionCarteRecapitulatif :arreteRestriction="arreteRestriction" />
      </div>
    </div>

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