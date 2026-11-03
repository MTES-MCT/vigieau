<script setup lang="ts">
const props = defineProps<{
  error: any
}>()

useHead({
  title: `Préservons l'eau - Erreur`
})
const invalidSituationLink = computed(() => props.error.data?.code === 'INVALID_SITUATION_COORDINATES');

if(props.error.statusCode === 404) {
  navigateTo('/')
}

const title = computed<string>(() => {
  return invalidSituationLink.value ? 'Lien de situation invalide' : 'Une erreur est survenue, ne paniquez pas'
});
const description = computed(() => invalidSituationLink.value
  ? 'Les coordonnées de ce lien sont invalides ou incomplètes. Effectuez une nouvelle recherche depuis la page d’accueil.'
  : '');
const subtitle = computed<string>(() => {
  return `Erreur ${props.error.statusCode} !`
});
const buttons = [
  {
    label: 'Page d\'accueil',
    onClick: () => {
      clearError({ redirect: '/' });
    }
  },
]
</script>

<template>
  <div>
    <NuxtLayout name="basic">
      <DsfrErrorPage
        class="fr-mt-8w"
        :title="title"
        :subtitle="subtitle"
        :description="description"
        help=""
        :buttons="buttons"
      />
    </NuxtLayout>
  </div>
</template>
