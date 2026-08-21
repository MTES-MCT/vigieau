<script setup lang="ts">
import { useScheme } from '@gouvminint/vue-dsfr';
import {
  ensureButtonAccessibleText,
  trapTabKey,
} from '../utils/focus-management';
import { getMandatoryFooterLinks } from '../utils/accessibility';

const route = useRoute();

const logoText: string[] = ['République', 'Française'];
const operatorImgSrc: string = '/logo_vigie_eau.svg';
const operatorImgAlt: string = `${useRuntimeConfig().public.appName}`;
const operatorImgStyle: any = {
  'max-width': '150px',
};
const serviceDescription =
  "S'informer sur les restrictions d'eau en période de sécheresse";
let quickLinks: any[] = [];
const mandatoryLinks: any[] = getMandatoryFooterLinks();
const ecosystemLinks: any[] = [
  {
    label: 'legifrance.gouv.fr',
    href: 'https://legifrance.gouv.fr',
    title: 'Légifrance, nouvelle fenêtre',
  },
  {
    label: 'info.gouv.fr',
    href: 'https://info.gouv.fr',
    title: 'Informations gouvernementales, nouvelle fenêtre',
  },
  {
    label: 'service-public.gouv.fr',
    href: 'https://service-public.gouv.fr',
    title: 'Informations et démarches administratives, nouvelle fenêtre',
  },
  {
    label: 'data.gouv.fr',
    href: 'https://data.gouv.fr',
    title: 'Plateforme des données publiques, nouvelle fenêtre',
  },
];
const key = ref(0);

const skipLinks = [
  { id: 'main-content', text: 'Contenu' },
  { id: 'footer', text: 'Pied de page' },
];

const preferences = reactive({
  theme: undefined,
  scheme: undefined,
});
const runTimeConfig = useRuntimeConfig().public;

function trapMenuFocus(event: KeyboardEvent): void {
  const menu = document.querySelector<HTMLElement>(
    '#header-navigation.fr-modal--opened',
  );
  if (menu) {
    trapTabKey(event, menu);
  }
}

function preserveFocusOnClosedHeaderEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') {
    return;
  }

  const openedHeaderMenu = document.querySelector(
    '#header-navigation.fr-modal--opened',
  );
  const previousFocus = document.activeElement;
  if (openedHeaderMenu || !(previousFocus instanceof HTMLElement)) {
    return;
  }

  queueMicrotask(() => {
    if (
      document.activeElement?.id === 'button-menu'
      && previousFocus.isConnected
    ) {
      previousFocus.focus({ preventScroll: true });
    }
  });
}

function focusMenuAfterOpening(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest('#button-menu')) {
    return;
  }

  focusOpenedMenuCloseButton();
}

function focusOpenedMenuCloseButton(attemptsRemaining = 5): void {
  requestAnimationFrame(() => {
    const menu = document.querySelector<HTMLElement>(
      '#header-navigation.fr-modal--opened',
    );
    const closeButton = menu?.querySelector<HTMLElement>('#close-button');
    closeButton?.focus();

    if (
      document.activeElement !== closeButton &&
      attemptsRemaining > 1
    ) {
      focusOpenedMenuCloseButton(attemptsRemaining - 1);
    }
  });
}

async function enhanceMenuButton(): Promise<void> {
  await nextTick();
  ensureButtonAccessibleText(document, 'button-menu', 'Menu');
}

onMounted(() => {
  document.addEventListener('keydown', preserveFocusOnClosedHeaderEscape, true);
  document.addEventListener('keydown', trapMenuFocus);
  document.addEventListener('click', focusMenuAfterOpening, true);
  const { theme, setScheme } = useScheme();
  // preferences.scheme = 'dark';
  preferences.scheme = 'light';

  watchEffect(() => {
    preferences.theme = theme.value;
  });

  watchEffect(() => setScheme(preferences.scheme));

  watch(
    () => route.path,
    (newPath) => {
      quickLinks =
        newPath === '/situation'
          ? [
              {
                label: 'Données sécheresse',
                icon: 'ri-water-percent-line',
                to: '/donnees',
              },
              {
                label: 'Effectuer une nouvelle recherche',
                icon: 'ri-search-line',
                to: '/',
              },
              {
                label: 'Donner mon avis',
                icon: 'ri-survey-line',
                button: true,
                'data-cy': 'OpenFeedbackForm',
                onClick: utils.openTally,
              },
            ]
          : [
              {
                label: 'Données sécheresse',
                icon: 'ri-water-percent-line',
                to: '/donnees',
              },
            ];
      key.value++;
      void enhanceMenuButton();
    },
    { immediate: true },
  );
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', preserveFocusOnClosedHeaderEscape, true);
  document.removeEventListener('keydown', trapMenuFocus);
  document.removeEventListener('click', focusMenuAfterOpening, true);
});
</script>

<template>
  <DsfrSkipLinks :links="skipLinks" />

  <DsfrHeader
    :key="key"
    :logo-text="logoText"
    :operator-img-src="operatorImgSrc"
    :operator-img-alt="operatorImgAlt"
    :operator-img-style="operatorImgStyle"
    :quick-links="quickLinks"
    menu-modal-label="Menu"
    :show-beta="
      runTimeConfig.domainName !== 'vigieau.gouv.fr' ||
        runTimeConfig.domainProdNotActivated === 'true'
    "
    :service-title="runTimeConfig.domainName"
    :service-description="serviceDescription"
  />
  <main id="main-content" role="main" tabindex="-1">
    <div class="fr-mb-8w">
      <div v-if="runTimeConfig.appEnv !== 'prod'" class="fr-container">
        <DsfrAlert
          title="Plateforme de développement"
          description="Plateforme de développement, les données sont fictives. Si vous souhaitez accéder à la plateforme de production, allez sur https://vigieau.gouv.fr"
          type="warning"
          class="fr-my-2w"
          :closeable="false"
        />
      </div>
      <slot />
    </div>
  </main>
  <DsfrFooter
    :logo-text="logoText"
    :mandatory-links="mandatoryLinks"
    :operator-img-src="operatorImgSrc"
    :operator-img-alt="operatorImgAlt"
    :operator-img-style="operatorImgStyle"
    :ecosystem-links="ecosystemLinks"
    :desc-text="serviceDescription"
    home-title="Accueil VigiEau"
    tabindex="-1"
  />
</template>

<style scoped lang="scss"></style>
