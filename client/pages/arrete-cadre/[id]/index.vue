<script setup lang="ts">
definePageMeta({
  layout: 'basic',
  middleware: 'role',
  roles: ['mte', 'departement'],
});

useHead({
  title: `Consultation arrêté cadre - ${useRuntimeConfig().public.appName}`,
});

const breadcrumb = [
  {
    to: "/arrete-cadre",
    text: "Arrêtés cadre"
  }, {
    text: "Consultation"
  }
];
</script>

<template>
  <DsfrBreadcrumb :links="breadcrumb" />
  <ArreteCadreConsultation />
</template>
