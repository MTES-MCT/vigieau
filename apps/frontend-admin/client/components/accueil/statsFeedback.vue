<script setup lang="ts">

import type { Ref } from 'vue';
import type { PaginatedResult } from '~/dto/paginated_result.dto';

const feedbacksPaginated: Ref<PaginatedResult<any> | null> = ref(null);

const api = useApi();
const utils = useUtils();
const router = useRouter();
const { data, error } = await api.usageFeedback.paginate(1, undefined, undefined, 3);
if (data.value) {
  feedbacksPaginated.value = data.value;
}

</script>

<template>
  <div class="fr-card fr-p-2w feedbacks-wrapper">
    <h2 class="text-align-center">Restrictions non comprise par les usagers (sur VigiEau)</h2>
    <div class="fr-grid-row" v-if="feedbacksPaginated">
      <div class="fr-col-12 feedback-card fr-mb-1w" v-for="feedback of feedbacksPaginated.data">
        <div>
          Le {{ utils.formatDate(feedback.createdAt) }}<br />
          La restriction <b>{{ feedback.usageNom }}</b> n'est pas comprise.
        </div>
        <div v-if="feedback.feedback">
          Commentaire&nbsp;: {{ feedback.feedback }}
        </div>
      </div>
      <div class="fr-col-12 feedback-card" v-if="feedbacksPaginated.data.length < 1">
        Aucune restriction non comprise.
      </div>
      <div class="fr-col-12 text-align-right" v-else>
        <DsfrButton secondary
                    iconRight
                    icon="ri-arrow-right-line"
                    @click="router.push('/commentaires')">
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