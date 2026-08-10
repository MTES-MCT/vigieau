<script setup lang="ts">
defineProps<{
  situationLabel: string
  address: string
}>();

const urlToShare = encodeURIComponent(window.location.href);

const networks = [
  {
    name: "facebook",
    label: "Partager sur Facebook",
    url: `https://www.facebook.com/sharer.php?u=${urlToShare}`
  },
  {
    name: "linkedin",
    label: "Partager sur LinkedIn",
    url: `https://www.linkedin.com/sharing/share-offsite/?url=${urlToShare}`
  }
];
</script>

<template>
  <DsfrShare title="Partagez votre situation - Attention l'adresse utilisée sera visible"
             :networks="networks"/>
</template>
