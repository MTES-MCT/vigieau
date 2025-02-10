<script setup lang="ts">
definePageMeta({
  layout: 'basic',
  middleware: 'role',
  roles: ['mte', 'departement'],
});

useHead({
  title: `Edition arrêté cadre - ${useRuntimeConfig().public.appName}`,
});

const route = useRoute();
const breadcrumb = [
  {
    to: "/arrete-cadre",
    text: "Arrêtés cadre"
  }, {
    text: route.params.id === 'nouveau' ? 'Création' : 'Edition'
  }
];
</script>

<template>
  <DsfrBreadcrumb :links="breadcrumb" />
  <ArreteCadreForm />
</template>
