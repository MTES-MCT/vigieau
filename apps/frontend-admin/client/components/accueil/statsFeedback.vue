<script setup lang="ts">
import type { Ref } from 'vue';
import type { PaginatedResult } from '~/dto/paginated_result.dto';

const feedbacksPaginated: Ref<PaginatedResult<any> | null> = ref(null);
const feedbacksLoading = ref(true);
const feedbacksError = ref(false);

const api = useApi();
const utils = useUtils();
const router = useRouter();
const loadFeedbacks = async () => {
  feedbacksLoading.value = true;
  feedbacksError.value = false;
  const { data, error } = await api.usageFeedback.paginate(1, undefined, undefined, 3);
  if (data.value) {
    feedbacksPaginated.value = data.value;
  }
  feedbacksError.value = !!error.value;
  feedbacksLoading.value = false;
};

onMounted(() => {
  loadFeedbacks();
});
</script>

<template>
  <div class="fr-card fr-p-2w feedbacks-wrapper">
    <h2 class="text-align-center">Restrictions non comprise par les usagers (sur VigiEau)</h2>
    <p v-if="feedbacksLoading" class="fr-mb-0">Chargement des commentaires</p>
    <DsfrAlert v-if="feedbacksError" type="error" description="Les commentaires ne sont pas disponibles pour le moment." :small="true" />
    <div class="fr-grid-row" v-if="feedbacksPaginated">
      <div class="fr-col-12 feedback-card fr-mb-1w" v-for="feedback of feedbacksPaginated.data">
        <div>
          Le {{ utils.formatDate(feedback.createdAt) }}<br />
          La restriction <b>{{ feedback.usageNom }}</b> n'est pas comprise.
        </div>
        <div v-if="feedback.feedback">Commentaire&nbsp;: {{ feedback.feedback }}</div>
      </div>
      <div class="fr-col-12 feedback-card" v-if="feedbacksPaginated.data.length < 1">Aucune restriction non comprise.</div>
      <div class="fr-col-12 text-align-right" v-else>
        <DsfrButton secondary iconRight icon="ri-arrow-right-line" @click="router.push('/commentaires')">
          Accéder aux {{ feedbacksPaginated.meta.totalItems }} commentaires
        </DsfrButton>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.feedback-card {
  background-color: var(--blue-france-950-100);
  padding: 1rem;
}
</style>
