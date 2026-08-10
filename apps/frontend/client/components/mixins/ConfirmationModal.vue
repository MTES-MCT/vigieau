<script setup lang="ts">
import type { Ref } from 'vue';

defineProps<{
  opened: string;
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
    onclick: () => {
      emit('confirm');
    },
  },
  {
    label: 'Annuler',
    secondary: true,
    onclick: () => {
      emit('close');
    },
  },
]);
</script>

<template>
  <DsfrModal
    :opened="opened"
    icon="ri-arrow-right-line"
    :title="title"
    :actions="modalActions"
    @close="emit('close')"
  >
    <p>{{ description }}</p>
  </DsfrModal>
</template>
