<script setup lang="ts">
import {
  DsfrBreadcrumb,
  type DsfrBreadcrumbProps,
} from '@gouvminint/vue-dsfr';
import { computed, nextTick, useAttrs } from 'vue';
import { focusFirstBreadcrumbLink } from '../utils/focus-management';

defineOptions({
  inheritAttrs: false,
});

const props = defineProps<DsfrBreadcrumbProps>();
const attrs = useAttrs();
const breadcrumbBindings = computed(() => ({
  ...attrs,
  ...props,
}));

const nextAnimationFrame = () =>
  new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

const handleBreadcrumbClick = async (event: MouseEvent) => {
  const target = event.target;
  const breadcrumb = event.currentTarget;

  if (
    !(target instanceof Element) ||
    !target.closest('.fr-breadcrumb__button') ||
    !(breadcrumb instanceof HTMLElement)
  ) {
    return;
  }

  await nextTick();
  await nextAnimationFrame();
  await nextAnimationFrame();
  await nextTick();

  focusFirstBreadcrumbLink(breadcrumb);
};
</script>

<template>
  <DsfrBreadcrumb
    v-bind="breadcrumbBindings"
    @click="handleBreadcrumbClick"
  />
</template>
