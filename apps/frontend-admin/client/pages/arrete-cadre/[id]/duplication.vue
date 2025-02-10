<script setup lang="ts">
definePageMeta({
  layout: 'basic',
  middleware: 'role',
  roles: ['mte', 'departement'],
});

useHead({
  title: `Duplication arrêté cadre - ${useRuntimeConfig().public.appName}`,
});

const breadcrumb = [
  {
    to: "/arrete-cadre",
    text: "Arrêtés cadre"
  }, {
    text: "Duplication"
  }
];
</script>

<template>
  <DsfrBreadcrumb :links="breadcrumb" />
  <ArreteCadreForm :duplicate="true" />
</template>
