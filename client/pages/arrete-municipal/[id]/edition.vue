<script setup lang="ts">
definePageMeta({
  layout: 'basic',
});

useHead({
  title: `Edition arrêté municipal - ${useRuntimeConfig().public.appName}`,
});


const route = useRoute();
const breadcrumb = [
  {
    to: "/arrete-municipal",
    text: "Arrêtés municipaux"
  }, {
    text: route.params.id === 'nouveau' ? 'Création' : 'Edition'
  }
];
</script>

<template>
  <DsfrBreadcrumb :links="breadcrumb" />
  <ArreteMunicipalForm />
</template>