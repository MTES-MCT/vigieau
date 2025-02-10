<script setup lang="ts">
const cartes = [
  {
    title: 'Prenez facilement l’outil en main',
    description: 'Accéder aux contenus de formation',
    img: '/accueil_1.png',
    link: {
      label: 'Accéder au pas à pas',
      href: 'https://aide.vigieau.beta.gouv.fr',
      external: true,
    },
  },
  {
    title: 'Gestion des arrêtés cadre',
    description: 'Créer, modifier et abroger les arrêtés cadre départementaux et interdépartementaux',
    img: '/accueil_2.png',
    link: {
      label: 'Les arrêtés cadres',
      to: '/arrete-cadre',
    },
  },
  {
    title: 'Gestion des arrêtés de restriction',
    description: 'Créer, abroger et remplacer les arrêtés de restriction.',
    img: '/accueil_3.png',
    link: {
      label: 'Les arrêtés de restriction',
      to: '/arrete-restriction',
    },
  },
];
</script>

<template>
  <div class="fr-grid-row fr-grid-row--gutters">
    <div class="fr-col-12 fr-col-lg-4" v-for="carte of cartes">
      <div class="fr-card fr-card--horizontal fr-enlarge-link fr-card--sm">
        <div class="fr-card__body">
          <div class="fr-card__content">
            <h3 class="fr-card__title">
              <template v-if="carte.link.external">
                <a :href="carte.link.href" target="_blank">{{ carte.title }}</a>
              </template>
              <template v-else>
                <nuxt-link :to="carte.link.to">{{ carte.title }}</nuxt-link>
              </template>
            </h3>
            <p class="fr-card__desc">
              {{ carte.description }}
            </p>
          </div>
        </div>
        <div class="fr-card__header">
          <div class="fr-card__img">
            <img class="fr-responsive-img" :src="carte.img" alt="Image d'illustration" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>