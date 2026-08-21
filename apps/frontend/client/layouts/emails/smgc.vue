<script setup lang="ts">
import { getMandatoryFooterLinks } from '../../utils/accessibility';

const logoText = ['Ministère', 'de la transition', 'écologique', 'et de la cohésion', 'des territoires'];
const operatorImgSrc: string = '/logo_smgc_veolia.png'
const operatorImgAlt: string = 'SMGC et Veolia'
const operatorImgStyle: any = {
  'max-width': '300px'
};
const quickLinks: any[] = [];
const mandatoryLinks: any[] = getMandatoryFooterLinks();
const ecosystemLinks: any[] = [
  {
    "label": "beta.gouv.fr",
    "href": "https://beta.gouv.fr"
  },
  {
    "label": "gouvernement.fr",
    "href": "https://gouvernement.fr"
  },
  {
    "label": "data.gouv.fr",
    "href": "https://data.gouv.fr"
  }
];
const key = ref(0);
const runTimeConfig = useRuntimeConfig().public;
const skipLinks = [
  { id: 'main-content', text: 'Contenu' },
  { id: 'footer', text: 'Pied de page' },
];
</script>

<template>
  <DsfrSkipLinks :links="skipLinks" />
  <DsfrHeader :logo-text="logoText"
              :operatorImgSrc="operatorImgSrc"
              :operatorImgAlt="operatorImgAlt"
              :operatorImgStyle="operatorImgStyle"
              :quickLinks="quickLinks"
              :key="key"
              :show-beta="runTimeConfig.domainName !== 'vigieau.gouv.fr' || runTimeConfig.domainProdNotActivated === 'true'"
              service-title="VigiEau - SMGC et Veolia"
              service-description="Conseils pour économiser l’eau">
  </DsfrHeader>
  <main id="main-content" role="main" tabindex="-1" class="fr-mb-8w">
    <div class="fr-container" v-if="runTimeConfig.appEnv !== 'prod'">
      <DsfrAlert title="Plateforme de développement"
                 description="Plateforme de développement, les données sont fictives. Si vous souhaitez accéder à la plateforme de production, allez sur https://vigieau.gouv.fr"
                 type="warning"
                 class="fr-my-2w"
                 :closeable="false"
      />
    </div>
    <slot/>
  </main>
  <DsfrFooter :logo-text="logoText"
              :mandatoryLinks="mandatoryLinks"
              :operatorImgSrc="operatorImgSrc"
              :operatorImgAlt="operatorImgAlt"
              :operatorImgStyle="operatorImgStyle"
              :ecosystemLinks="ecosystemLinks"
              tabindex="-1">
  </DsfrFooter>
</template>

<style lang="scss">
</style>
