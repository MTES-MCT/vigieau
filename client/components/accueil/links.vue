<script setup lang="ts">
const liensUtiles = [
  {
    label: 'Etat étiage (visualiser facilement l\'état des cours d’eau) :',
    labelHref: 'https://www.etat-etiage.fr',
    href: 'https://www.etat-etiage.fr',
  },
  {
    label: 'MétéoFrance (accéder aux données hydro-climatiques utiles pour la gestion sécheresse) :',
    labelHref: 'Météo-France Pro',
    href: 'https://pro.meteofrance.com/',
  },
  {
    label: 'Bulletin de situation hydrologique (suivre l\'évolution mensuelle des ressources en eau) :',
    labelHref: 'Bulletins de situation hydrologique | Eaufrance',
    href: 'https://www.eaufrance.fr/publications/bsh',
  },
  {
    label: 'SANDRE (se renseigner sur le référentiel des zones d’alerte) :',
    labelHref: 'https://www.sandre.eaufrance.fr/atlas/srv/fre/catalog.search#/metadata/0391a8b8-c850-45c7-a372-1f95bd204159',
    href: 'https://www.sandre.eaufrance.fr/atlas/srv/fre/catalog.search#/metadata/0391a8b8-c850-45c7-a372-1f95bd204159',
  },
  {
    label: 'Guide circulaire sécheresse :',
    labelHref: 'https://www.ecologie.gouv.fr/sites/default/files/Guide circulaire secheresse-conforme1605.pdf',
    href: 'https://www.ecologie.gouv.fr/sites/default/files/Guide circulaire secheresse-conforme1605.pdf',
  },
];
</script>

<template>
  <div class="fr-card fr-p-2w">
    <h2>Liens utiles</h2>
    <ul>
      <li v-for="lien in liensUtiles" class="fr-mb-2w">
        {{ lien.label }}<br />
        <a class="fr-link" :href="lien.href" target="_blank">{{ lien.labelHref }}</a>
      </li>
    </ul>
  </div>
</template>