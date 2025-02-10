<script setup lang="ts">
definePageMeta({
  layout: 'basic',
  middleware: 'role',
  roles: ['mte', 'departement'],
});

useHead({
  title: `Commentaires - ${useRuntimeConfig().public.appName}`,
});

const breadcrumb = [
  {
    to: "/",
    text: "Accueil"
  }, {
    text: "Commentaires"
  }
];
</script>

<template>
  <DsfrBreadcrumb :links="breadcrumb" />
  <h1 class="fr-mb-4w">
    Commentaires <span class="fr-h6">partagés par les usagers Vigieau lorsqu’une restriction n’est pas comprise</span>
  </h1>
  
  <FeedbackList />
</template>