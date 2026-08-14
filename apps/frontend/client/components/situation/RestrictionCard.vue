<script setup lang="ts">
import { Usage } from '../../dto/usage.dto';
import api from '../../api';

const props = defineProps<{
  usage: Usage,
  departement: string,
  thematique: any
}>();

const instanceId = useId();
const feedbackComment = ref('');
const feedbackStatus = ref('');
const isSubmittingFeedback = ref(false);
const modalStep = ref<'feedback' | 'success' | null>(null);
const cardId = `restriction-title-${instanceId}`;
const questionBtn = ref<{ focus: () => void } | null>(null);
let feedbackRequestGeneration = 0;
const modalOpened = computed(() => modalStep.value !== null);
const modalTitle = computed(() => (
  modalStep.value === 'success'
    ? 'Votre retour a été envoyé'
    : 'Je ne comprends pas cette restriction'
));
const modalIcon = computed(() => (
  modalStep.value === 'success'
    ? 'ri-checkbox-circle-line'
    : 'ri-question-line'
));

const openModal = () => {
  feedbackRequestGeneration += 1;
  isSubmittingFeedback.value = false;
  feedbackStatus.value = '';
  modalStep.value = 'feedback';
};

const closeModal = () => {
  feedbackRequestGeneration += 1;
  isSubmittingFeedback.value = false;
  modalStep.value = null;
  feedbackComment.value = '';
  feedbackStatus.value = '';
};

const signalRestriction = async () => {
  if (isSubmittingFeedback.value) {
    return;
  }

  isSubmittingFeedback.value = true;
  feedbackStatus.value = 'Envoi du retour en cours.';
  const requestGeneration = ++feedbackRequestGeneration;

  try {
    const { error } = await api.signalRestriction(
      props.usage.id,
      feedbackComment.value,
    );

    if (
      requestGeneration !== feedbackRequestGeneration
      || modalStep.value !== 'feedback'
    ) {
      return;
    }

    if (error?.value) {
      feedbackStatus.value = 'Votre retour n’a pas pu être envoyé. Veuillez réessayer.';
      return;
    }

    feedbackComment.value = '';
    feedbackStatus.value = 'Votre retour a bien été pris en compte !';
    modalStep.value = 'success';
  } catch {
    if (
      requestGeneration === feedbackRequestGeneration
      && modalStep.value === 'feedback'
    ) {
      feedbackStatus.value = 'Votre retour n’a pas pu être envoyé. Veuillez réessayer.';
    }
  } finally {
    if (requestGeneration === feedbackRequestGeneration) {
      isSubmittingFeedback.value = false;
    }
  }
};

const modalActions = computed<any[]>(() => modalStep.value === 'success'
  ? [{ label: 'Fermer', onClick: closeModal }]
  : [
      {
        label: 'Je ne comprends pas cette restriction',
        onClick: signalRestriction,
      },
      {
        label: 'Annuler et fermer',
        onClick: closeModal,
        secondary: true,
      },
    ]);
</script>

<template>
  <div class="eau-card fr-p-2w">
    <div class="eau-card__title fr-mb-1w">
      <h3 :id="cardId" class="h6 fr-m-0">
        {{ usage.nom }}
      </h3>

      <DsfrButton
        ref="questionBtn"
        icon="ri-question-line"
        label="Je ne comprends pas cette restriction"
        icon-only
        tertiary
        no-outline
        size="small"
        :aria-describedby="cardId"
        @click="openModal"
      />
    </div>
    <p class="eau-card__desc fr-mb-0">
      {{ usage.description }}
    </p>
  </div>
  <AccessibleModal
    :opened="modalOpened"
    :origin="questionBtn ?? undefined"
    :title="modalTitle"
    :icon="modalIcon"
    :actions="modalActions"
    :aria-busy="isSubmittingFeedback"
    data-cy="RestrictionFeedbackModal"
    @close="closeModal"
  >
    <p
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-cy="RestrictionFeedbackStatus"
    >
      {{ feedbackStatus }}
    </p>
    <template v-if="modalStep === 'feedback'">
      <p>
        Si la restriction « {{ usage.nom }} » est peu compréhensible, merci de
        nous le faire remonter.
      </p>
      <p>
        Nous la modifierons si nécessaire !
      </p>
      <DsfrInputGroup>
        <DsfrInput
          v-model="feedbackComment"
          :is-textarea="true"
          label="Commentaire (facultatif)"
          label-visible
          type="text"
          rows="4"
          :required="false"
          maxlength="255"
        />
        <span class="fr-input-group__sub-hint">
          {{ feedbackComment ? feedbackComment.length : 0 }}/255
        </span>
      </DsfrInputGroup>
    </template>
  </AccessibleModal>
</template>

<style lang="scss" scoped>
.eau-card {
  .eau-card {
    &__title {
      h3 {
        color: currentColor;
      }
    }

    &__header {
      color: var(--blue-france-sun-113-625);
    }

    &__desc {
      white-space: pre-wrap;
      font-size: 1rem;
    }
  }
}
</style>
