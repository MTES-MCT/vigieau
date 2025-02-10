<script setup lang="ts">
definePageMeta({
  layout: 'basic',
});

useHead({
  title: `Arrêtés Municipaux - ${useRuntimeConfig().public.appName}`,
});
</script>

<template>
  <div class="am-list">
    <ArreteMunicipalList />
  </div>
</template>

<style lang="scss">
.am-list {
  position: relative;

  &:before {
    content: '';
    position: absolute;
    height: calc(100% + 4rem);
    width: 100vw;
    top: -2rem;
    left: -1.5rem;
    background: linear-gradient(var(--grey-975-75), var(--blue-france-950-100));
    z-index: -1;
  }
}

@media (min-width: 78em) {
  .am-list:before {
    left: calc(-1.5rem - (100vw - 78rem) / 2);
  }
}
</style>