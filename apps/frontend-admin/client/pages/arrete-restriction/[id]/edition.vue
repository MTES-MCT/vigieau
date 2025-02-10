<script setup lang="ts">
definePageMeta({
  layout: 'basic',
  middleware: 'role',
  roles: ['mte', 'departement'],
});

useHead({
  title: `Edition arrêté de restriction - ${useRuntimeConfig().public.appName}`,
});


const route = useRoute();
const breadcrumb = [
  {
    to: "/arrete-restriction",
    text: "Arrêtés de restriction"
  }, {
    text: route.params.id === 'nouveau' ? 'Création' : 'Edition'
  }
];
</script>

<template>
  <DsfrBreadcrumb :links="breadcrumb" />
  <ArreteRestrictionForm />
</template>
