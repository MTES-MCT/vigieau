<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { getHorizontalTabIndex } from '../utils/tab-navigation';

export interface AccessibleTab {
  id: string;
  label: string;
}

const props = defineProps<{
  idPrefix: string;
  label: string;
  modelValue: number;
  tabs: AccessibleTab[];
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', tabIndex: number): void;
}>();

const tabsRoot = ref<HTMLElement | null>(null);

const tabId = (tab: AccessibleTab) => `${props.idPrefix}-tab-${tab.id}`;
const panelId = (tab: AccessibleTab) =>
  `${props.idPrefix}-panel-${tab.id}`;

const selectTab = async (tabIndex: number, moveFocus = false) => {
  emit('update:modelValue', tabIndex);

  if (!moveFocus) {
    return;
  }

  await nextTick();
  tabsRoot.value
    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    .item(tabIndex)
    ?.focus();
};

const onTabKeydown = (event: KeyboardEvent, currentIndex: number) => {
  const nextIndex = getHorizontalTabIndex(
    currentIndex,
    props.tabs.length,
    event.key,
  );
  if (nextIndex === null) {
    return;
  }

  event.preventDefault();
  void selectTab(nextIndex, true);
};
</script>

<template>
  <div ref="tabsRoot" class="fr-tabs">
    <ul class="fr-tabs__list" role="tablist" :aria-label="label">
      <li v-for="(tab, index) in tabs" :key="tab.id" role="presentation">
        <button
          :id="tabId(tab)"
          class="fr-tabs__tab"
          type="button"
          role="tab"
          :aria-controls="panelId(tab)"
          :aria-selected="modelValue === index"
          :tabindex="modelValue === index ? 0 : -1"
          @click="selectTab(index)"
          @keydown="onTabKeydown($event, index)"
        >
          {{ tab.label }}
        </button>
      </li>
    </ul>

    <div
      v-for="(tab, index) in tabs"
      v-show="modelValue === index"
      :id="panelId(tab)"
      :key="tab.id"
      class="fr-tabs__panel"
      :class="{ 'fr-tabs__panel--selected': modelValue === index }"
      role="tabpanel"
      :aria-labelledby="tabId(tab)"
      tabindex="-1"
    >
      <slot :name="tab.id" />
    </div>
  </div>
</template>
