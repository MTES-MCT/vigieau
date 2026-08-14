<script setup lang="ts">
import type { Ref } from 'vue';

defineProps<{
  opened: boolean;
  title: string;
  description: string;
}>();

const emit = defineEmits<{
  close: any;
  confirm: any;
}>();

const modalActions: Ref<any[]> = ref([
  {
    label: 'Confirmer',
    onClick: () => {
      emit('confirm');
    },
  },
  {
    label: 'Annuler',
    secondary: true,
    onClick: () => {
      emit('close');
    },
  },
]);
</script>

<template>
  <AccessibleModal
    :opened="opened"
    icon="ri-arrow-right-line"
    :title="title"
    :actions="modalActions"
    @close="emit('close')"
  >
    <p>{{ description }}</p>
  </AccessibleModal>
</template>
