<script setup lang="ts">
import { Ref } from 'vue';

definePageMeta({
  layout: 'basic',
});

useHead({
  title: `Données - ${useRuntimeConfig().public.appName}`,
});

const links: Ref<any[]> = ref([{ to: '/', text: 'Accueil' }, { text: 'Données sécheresse' }]);
const email = useRuntimeConfig().public.email;
</script>

<template>
  <div class="fr-container">
    <DsfrBreadcrumb :links='links' />
    <h1>Données sécheresse</h1>
    <DsfrHighlight class="fr-mb-2w">
      Retrouvez les données brutes sur <a href="https://www.data.gouv.fr/fr/datasets/donnee-secheresse-vigieau/"
                                          title="Lien vers data.gouv (nouvelle fenêtre)"
                                          target="_blank"
                                          rel="external"
                                          class="fr-link">data.gouv</a><br />
      Si vous avez des besoins spécifiques, envoyez nous un email à  <a class="fr-link"
                                                                        :title="`Contactez-nous sur ${email}`"
                                                                        :href="`mailto:${email}`">
      {{ email }}
    </a>
    </DsfrHighlight>
  </div>
  <div class="background-blue fr-py-2w">
    <div class="fr-container">
      <div class="fr-grid-row fr-grid-row--gutters">
        <div class="fr-col-12 fr-col-md-6 fr-col-lg-3">
          <DsfrCard
            img-src="/donnee_carte_historique.png"
            link="/donnees/carte-historique"
            alt-img=""
            title="Carte et historique des restrictions"
          >
          </DsfrCard>
        </div>
        <div class="fr-col-12 fr-col-md-6 fr-col-lg-3">
          <DsfrCard
            img-src="/donnee_graphe_surface.png"
            link="/donnees/surface"
            alt-img=""
            title="Évolution journalière du pourcentage de la surface concernée par des niveaux de gravité"
          >
          </DsfrCard>
        </div>
        <div class="fr-col-12 fr-col-md-6 fr-col-lg-3">
          <DsfrCard
            img-src="/donnee_graphe_departement.png"
            link="/donnees/departement"
            alt-img=""
            title="Évolution journalière du nombre de départements soumis à restriction"
          >
          </DsfrCard>
        </div>
        <div class="fr-col-12 fr-col-md-6 fr-col-lg-3">
          <DsfrCard
            img-src="/donnee_carte_commune.png"
            link="/donnees/carte-commune"
            alt-img=""
            title="Intensité des sécheresses passées"
          >
          </DsfrCard>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss">
.background-blue {
  background-color: var(--blue-france-975-75);
}
</style>