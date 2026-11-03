<script setup lang="ts">
defineProps<{
  situationLabel: string
  address: string
}>();

const route = useRoute();
const urlToShare = computed(() => encodeURIComponent(new URL(route.fullPath, window.location.origin).href));

const networks = computed(() => [
  {
    name: "facebook",
    label: "Partager sur Facebook",
    url: `https://www.facebook.com/sharer.php?u=${urlToShare.value}`
  },
  {
    name: "linkedin",
    label: "Partager sur LinkedIn",
    url: `https://www.linkedin.com/sharing/share-offsite/?url=${urlToShare.value}`
  }
]);
</script>

<template>
  <DsfrShare
    title="Partagez votre situation - Attention l'adresse utilisée sera visible"
    :networks="networks"
  />
</template>
