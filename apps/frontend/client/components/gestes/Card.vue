<script setup lang="ts">
import { Icon } from '@iconify/vue';

defineProps<{
  geste: {
    title: string;
    description: string;
    home: boolean;
    large: boolean;
    icon: string;
  };
}>();
</script>

<template>
  <li class="fr-col-12 fr-col-md-4" :class="geste.large ? '' : 'fr-col-lg-3'">
    <div class="eau-card fr-p-2w">
      <p class="eau-card__statement fr-my-2w">
        <span class="fr-grid-row">
          <span
            v-if="geste.icon"
            class="fr-col-3 eau-card__icon"
            aria-hidden="true"
          >
            <Icon
              :icon="`vigieau:${geste.icon}`"
              :style="{ fontSize: '3.6rem' }"
            />
          </span>
          <span :class="geste.icon ? 'fr-col-9' : 'fr-col-12'">
            <strong class="eau-card__title">
              {{ geste.title }}
            </strong>
            <span class="eau-card__desc"> {{ geste.description }}</span>
          </span>
        </span>
      </p>
    </div>
  </li>
</template>

<style lang="scss" scoped>
.eau-card {
  background-color: var(--background-default-grey);

  &__icon {
    max-width: 60px;
  }

  &__title {
    font-size: 1.125rem;
    line-height: 1.5rem;
  }
}
</style>
