<script setup lang="ts">
import { ref, type Ref, watch } from 'vue';
import { Profile } from '../../dto/profile.enum';

const props = defineProps({
  profile: {
    type: String,
    default: '',
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  required: {
    type: Boolean,
    default: false,
  },
  ariaInvalid: {
    type: Boolean,
    default: false,
  },
  errorMessage: {
    type: String,
    default: '',
  },
  groupId: {
    type: String,
    default: 'profile-selection-group',
  },
  errorId: {
    type: String,
    default: 'profile-selection-error',
  },
});

const emit = defineEmits<{
  profileUpdate: [profile: string]
}>();

const isKnownProfile = (profile: string): boolean => (
  Object.prototype.hasOwnProperty.call(Profile, profile)
);

const selectedTagType: Ref<string> = ref(
  isKnownProfile(props.profile) ? props.profile : 'particulier',
);
const profileTags = Object.entries(Profile).map(([type, label]) => ({
  label,
  type,
}));

watch(() => props.profile, (profile) => {
  if (isKnownProfile(profile)) {
    selectedTagType.value = profile;
  }
});

const selectProfile = (profile: string) => {
  selectedTagType.value = profile;
  emit('profileUpdate', profile);
};
</script>

<template>
  <div data-cy="ProfileSelection">
    <fieldset
      :id="groupId"
      class="fr-fieldset"
      :disabled="disabled"
      :aria-invalid="ariaInvalid || undefined"
      :aria-describedby="ariaInvalid && errorMessage ? errorId : undefined"
    >
      <legend class="fr-fieldset__legend fr-text--regular">
        Agissez-vous en tant que ?
        <span
          v-if="required"
          class="required"
        > (obligatoire)</span>
      </legend>
      <button
        v-for="tag in profileTags"
        :id="`${groupId}-${tag.type}`"
        :key="tag.type"
        type="button"
        class="fr-tag fr-m-1w tag-lg"
        :aria-pressed="selectedTagType === tag.type"
        :aria-describedby="ariaInvalid && errorMessage ? errorId : undefined"
        :disabled="disabled"
        @click="selectProfile(tag.type)"
      >
        {{ tag.label }}
      </button>
      <p
        v-if="errorMessage"
        :id="errorId"
        class="fr-error-text fr-mt-1w"
        role="alert"
      >
        {{ errorMessage }}
      </p>
    </fieldset>
  </div>
</template>
