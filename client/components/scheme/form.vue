<script setup lang="ts">
import { useScheme } from '@gouvminint/vue-dsfr';
import type { Ref } from 'vue';

const currentScheme: Ref<string> = ref('');
const options = [
  {
    label: 'Thème clair',
    value: 'light',
  },
  {
    label: 'Thème sombre',
    value: 'dark',
  },
  {
    label: 'Système',
    value: 'system',
    hint: 'Utilise les paramètres système',
  },
];

onMounted(() => {
  const { theme, scheme, setScheme } = useScheme();
  currentScheme.value = scheme.value;
});

defineExpose({
  currentScheme,
});
</script>

<template>
  <DsfrRadioButtonSet
    legend="Choisissez un thème pour personnaliser l’apparence du site."
    :options="options"
    v-model="currentScheme"
    :small="false"
  />
</template>
