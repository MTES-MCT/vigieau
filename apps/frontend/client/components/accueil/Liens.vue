<script setup lang="ts">
import liens from '../../data/liens.json'
</script>

<template>
  <div class="liens-background">
    <div class="liens fr-container fr-py-4w">
      <div class="section-title">
        <h2>Les liens utiles</h2>
        <p>Toutes les ressources officielles sur la gestion de l'eau&nbsp;:</p>
      </div>
      <div>
        <ul>
          <li v-for="lien in liens.data" :key="lien.link">
            <a
              :href="lien.link"
              target="_blank"
              rel="external"
              class="fr-link"
              :title="`${lien.title} (nouvelle fenêtre)`"
            >
              {{ lien.title }}
            </a>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style lang="scss">
.liens-background {
  isolation: isolate;
  position: relative;

  &::before {
    background: var(--brown-cafe-creme-975-75);
    content: "";
    inset: 0;
    opacity: 0.5;
    position: absolute;
    z-index: -1;
  }
}
</style>
