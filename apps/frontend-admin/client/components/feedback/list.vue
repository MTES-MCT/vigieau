<script setup lang="ts">
import type { Ref } from 'vue';
import type { PaginatedResult } from '~/dto/paginated_result.dto';
import type { ArreteCadre } from '~/dto/arrete_cadre.dto';
import { useAlertStore } from '~/stores/alert';

const feedbacksPaginated: Ref<PaginatedResult<any> | null> = ref(null);
const currentPage: Ref<number> = ref(0);
const loading = ref(false);

const api = useApi();
const utils = useUtils();
const router = useRouter();
const alertStore = useAlertStore();

const usageFeedbackToDelete = ref(null);
const modalOpened: Ref<boolean> = ref(false);
const modalTitle: Ref<string> = ref('Archivage d\'un commentaire');
const modalDescription: Ref<string> = ref('');
const modalActions: Ref<any[]> = ref([
  {
    label: 'Confirmer',
    onclick: () => {
      deleteUsageFeedback();
    },
  },
  {
    label: 'Annuler',
    secondary: true,
    onclick: () => {
      utils.closeModal(modalOpened);
    },
  },
]);

const paginate = async () => {
  loading.value = true;
  const { data, error } = await api.usageFeedback.paginate(currentPage.value + 1, undefined, undefined, 10);
  loading.value = false;
  if (data.value) {
    data.value.meta.dsfrPages = Array.from({ length: data.value.meta.totalPages }, (value, index) => {
      return {
        title: `Page ${index + 1}`,
        label: `${index + 1}`,
      };
    });
    feedbacksPaginated.value = data.value;
  }
};

const askDeleteUsageFeedback = async (usageFeedback: any) => {
  usageFeedbackToDelete.value = usageFeedback;
  modalDescription.value = `Voulez-vous archiver le commentaire concernant l'usage <b>${usageFeedback.usageNom}</b> ?
 <br/>Il ne sera plus visible.`;
  modalOpened.value = true;
};

const deleteUsageFeedback = async (id: string) => {
  if(!usageFeedbackToDelete.value) {
    return;
  }
  const { data, error } = await api.usageFeedback.delete(usageFeedbackToDelete.value.id);
  if(!error.value) {
    alertStore.addAlert({
      description: 'Archivage réussi',
      type: 'success',
    });
  }
  usageFeedbackToDelete.value = null;
  utils.closeModal(modalOpened);
  paginate();
};

paginate();
</script>

<template>
  <template v-if="feedbacksPaginated">
    <div class="fr-grid-row">
      <div class="fr-col-12 feedback-card fr-mb-2w" v-for="feedback of feedbacksPaginated.data">
        <div>
          Le {{ utils.formatDate(feedback.createdAt) }}<br />
          La restriction <b>{{ feedback.usageNom }}</b> n'est pas comprise.
        </div>
        <div v-if="feedback.feedback">
          Commentaire&nbsp;: {{ feedback.feedback }}
        </div>
        <div class="fr-grid-row fr-mt-1w">
          <DsfrButton v-if="feedback.arreteRestriction?.id"
                      tertiary
                      class="fr-mr-2w"
                      @click="router.push(`/arrete-restriction/${feedback.arreteRestriction.id}`)">
            Voir l'arrêté de restriction
          </DsfrButton>
          <DsfrButton v-if="feedback.arreteRestriction?.id"
                      tertiary
                      icon="ri-delete-bin-5-fill"
                      @click="askDeleteUsageFeedback(feedback)">
            Archiver le commentaire
          </DsfrButton>
        </div>
      </div>
      <div class="fr-col-12 text-align-center" v-if="feedbacksPaginated.data.length < 1">Aucune restriction non comprise.</div>
    </div>
    <div class="fr-grid-row fr-grid-row--center fr-mt-2w">
      <DsfrPagination v-model:current-page="currentPage"
                      :pages="feedbacksPaginated.meta.dsfrPages"
                      @update:current-page="paginate()" />
    </div>
  </template>
  <DsfrModal :opened="modalOpened"
             icon="ri-arrow-right-line"
             :title="modalTitle"
             :actions="modalActions"
             @close="modalOpened = utils.closeModal(modalOpened);">
    <div v-html="modalDescription"></div>
  </DsfrModal>
</template>

<style lang="scss" scoped>
.feedback-card {
  background-color: var(--blue-france-950-100);
  padding: 1rem;
}
</style>