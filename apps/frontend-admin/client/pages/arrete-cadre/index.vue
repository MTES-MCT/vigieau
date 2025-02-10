<script setup lang="ts">
definePageMeta({
  layout: 'basic',
  middleware: 'role',
  roles: ['mte', 'departement'],
});

useHead({
  title: `Arrêtés Cadre - ${useRuntimeConfig().public.appName}`,
});
</script>

<template>
  <div class="ac-list">
    <ArreteCadreList />
  </div>
</template>

<style lang="scss">
.ac-list {
  position: relative;

  &:before {
    content: '';
    position: absolute;
    height: calc(100% + 4rem);
    width: 100vw;
    top: -2rem;
    left: -1.5rem;
    background: linear-gradient(var(--blue-france-950-100), var(--grey-975-75));
    z-index: -1;
  }
}

@media (min-width: 78em) {
  .ac-list:before {
    left: calc(-1.5rem - (100vw - 78rem) / 2);
  }
}
</style>
