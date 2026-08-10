<script setup lang="ts">
const appName = useRuntimeConfig().public.appName;
useHead({
  title: `Carte des restrictions - ${appName}`,
});
</script>

<template>
  <main id="main-content" role="main" tabindex="-1">
    <CarteWrapper :embedded="true" />
  </main>
</template>
