<script setup lang="ts">
definePageMeta({
  layout: 'basic',
  middleware: 'role',
  roles: ['mte', 'departement'],
});

useHead({
  title: `Duplication arrêté de restriction - ${useRuntimeConfig().public.appName}`,
});

const breadcrumb = [
  {
    to: '/arrete-restriction',
    text: 'Arrêtés de restriction',
  }, {
    text: 'Duplication',
  },
];
</script>

<template>
  <DsfrBreadcrumb :links="breadcrumb" />
  <ArreteRestrictionForm :duplicate="true" />
</template>
