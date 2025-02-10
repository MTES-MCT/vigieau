<script setup lang="ts">
definePageMeta({
  layout: 'basic',
  middleware: 'role',
  roles: ['mte', 'departement'],
});

useHead({
  title: `Consultation arrêté de restriction - ${useRuntimeConfig().public.appName}`,
});

const breadcrumb = [
  {
    to: '/arrete-restriction',
    text: 'Arrêtés de restriction',
  }, {
    text: 'Consultation',
  },
];
</script>

<template>
  <DsfrBreadcrumb :links="breadcrumb" />
  <ArreteRestrictionConsultation />
</template>
