<script setup lang="ts">
import { useScheme } from '@gouvminint/vue-dsfr';
import { useAuthStore } from '~/stores/auth';
import type { Ref } from 'vue';
import { useContextStore } from '~/stores/context';

const runTimeConfig = useRuntimeConfig().public;
const authStore = useAuthStore();
const contextStore = useContextStore();
const serviceTitle = <string>runTimeConfig.appName;
const logoText = ['Ministère', 'de la transition', 'écologique', 'et de la cohésion', 'des territoires'];
const modalSchemeOpened = ref(false);
const schemeFormRef = ref(null);
const { theme, scheme, setScheme } = <any>useScheme();
const accountOpened = ref(false);
const route = useRoute();
const showAlerts = route.path !== '/connexion' && route.path !== '/';
const quickLinks: Ref<any[]> = ref([]);
const navItems: Ref<any[]> = ref([]);

const logout = function() {
  authStore.logout();
  contextStore.resetContext();
  navigateTo('/api/auth/logout', { external: true });
};

const a11yCompliance: string = 'Non conforme';
const accountOptions = (icon: boolean) => {
  const links = [];
  if (['mte', 'departement'].includes(authStore.user?.role)) {
    links.push({
      text: 'Gestion des arrêtés municipaux',
      onclick: () => {
        navigateTo('/arrete-municipal');
      },
      icon: icon ? 'ri-article-fill' : null,
    });
    links.push({
      text: 'Mon département',
      onclick: () => {
        navigateTo('/mon-departement');
      },
      icon: icon ? 'ri-settings-3-line' : null,
    });
  }
  links.push({
    text: 'Paramètres d\'affichage',
    onclick: () => {
      modalSchemeOpened.value = true;
    },
    icon: icon ? 'ri-sun-fill' : null,
  });
  links.push({
    text: 'Déconnexion',
    onclick: logout,
    icon: icon ? 'ri-logout-box-r-line' : null,
  });
  return links;
};
const loadQuickLinks = async () => {
  const isAuthenticated = await authStore.isAuthenticated;
  const links = [];
  if (isAuthenticated && ['mte', 'departement'].includes(authStore.user?.role)) {
    links.push({
      label: 'Gestion des arrêtés cadre',
      to: '/arrete-cadre',
    });
    links.push({
      label: 'Gestion des arrêtés de restriction',
      to: '/arrete-restriction',
    });
  }
  if (isAuthenticated) {
    links.push({
      label: 'Mon compte',
      icon: 'ri-account-circle-fill',
      to: '#',
      onclick: ($event) => {
        $event?.preventDefault();
        accountOpened.value = !accountOpened.value;
        setTimeout(() => {
          const buttons = document.querySelector('.fr-header .fr-btns-group');
          const menu = document.querySelector('.fr-header__menu-list-link');
          const menuWidth = menu?.getElementsByClassName('fr-menu__list')[0].getBoundingClientRect().width;
          if (!buttons || !menu || !menuWidth) {
            return;
          }
          menu.style['right'] = (document.body.clientWidth - buttons.getBoundingClientRect().right + menuWidth) + 'px';
        });
      },
    });
  }
  quickLinks.value = links;
};
const loadNavItems = async () => {
  const isAuthenticated = await authStore.isAuthenticated;
  const links = [];

  if (isAuthenticated && ['mte', 'departement'].includes(authStore.user?.role)) {
    links.push({
      text: 'Gestion des arrêtés cadre',
      to: '/arrete-cadre',
    });
    links.push({
      text: 'Gestion des arrêtés de restriction',
      to: '/arrete-restriction',
    });
  }
  if (isAuthenticated && ['departement', 'commune'].includes(authStore.user?.role)) {
    links.push({
      title: 'Mon compte',
      links: accountOptions(false),
    });
  }
  navItems.value = links;
};
const mandatoryLinks: any[] = [
  {
    label: `Accessibilité : ${a11yCompliance}`,
    to: '/accessibilite',
  },
  {
    label: 'Mentions légales',
    to: '/mentions-legales',
  },
  {
    label: 'Données personnelles',
    to: '/donnees-personnelles',
  },
];
const ecosystemLinks: any[] = [
  {
    label: 'beta.gouv.fr',
    href: 'https://beta.gouv.fr',
  },
  {
    label: 'gouvernement.fr',
    href: 'https://gouvernement.fr',
  },
  {
    label: 'data.gouv.fr',
    href: 'https://data.gouv.fr',
  },
];
const closeModal = () => {
  modalSchemeOpened.value = false;
};
const saveScheme = () => {
  preferences.scheme = schemeFormRef.value?.currentScheme;
  closeModal();
};
const modalActions: Ref<any[]> = ref([
  {
    label: 'Enregistrer',
    onClick: saveScheme,
  },
  {
    label: 'Annuler',
    onClick: closeModal,
    secondary: true,
  },
]);

const preferences = reactive({
  theme: undefined,
  scheme: undefined,
});

onMounted(() => {
  preferences.theme = theme.value;
  preferences.scheme = scheme.value;
  // preferences.scheme = 'light';

  watchEffect(() => {
    preferences.theme = theme.value;
  });

  watchEffect(() => setScheme(preferences.scheme));
});

const onKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    accountOpened.value = false;
  }
};

const onDocumentClick = (e: MouseEvent) => {
  handleElementClick(e.target as HTMLElement);
};

const handleElementClick = (el: HTMLElement) => {
  if (el === document.getElementById('account-menu-list')) {
    return;
  }

  if (!el?.parentNode) {
    accountOpened.value = false;
    return;
  }

  handleElementClick(el.parentNode as HTMLElement);
};

onMounted(() => {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeyDown);
});
onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick);
  document.removeEventListener('keydown', onKeyDown);
});

watch(authStore.user, async () => {
  await loadQuickLinks();
  await loadNavItems();
}, { immediate: true });
</script>

<template>
  <DsfrHeader
    :service-title="serviceTitle"
    :logo-text="logoText"
    :quickLinks="quickLinks"
    :show-beta="!+runTimeConfig.isProd"
    home-to="/"
  >
    <template #mainnav>
      <DsfrNavigation
        :nav-items="navItems"
      />
    </template>
  </DsfrHeader>
  <div v-show="accountOpened" id="account-menu-list" class="fr-header__menu-list-link">
    <div class="fr-menu">
      <ul class="fr-menu__list">
        <template v-for="action of accountOptions(true)">
          <li>
            <a class="fr-nav__link"
               @click="action.onclick(); accountOpened = false;">
              <VIcon :name="action.icon" class="fr-mr-1w" />
              {{ action.text }}
            </a>
          </li>
        </template>
      </ul>
    </div>
  </div>
  <main>
    <div class="fr-container fr-mb-6w" v-if="!+runTimeConfig.isProd">
      <DsfrAlert
        description="Plateforme de développement, les données sont fictives. Si vous souhaitez accéder à la plateforme de production, allez sur https://admin.vigieau.beta.gouv.fr"
        type="warning"
        class="fr-my-2w"
        :closeable="false"
      />
    </div>
    <MixinsAlerts v-if="showAlerts" class="fr-mb-2w" />
    <div class="fr-container fr-my-4w">
      <slot />
    </div>
  </main>
  <DsfrFooter :logo-text="logoText" :mandatoryLinks="mandatoryLinks" :ecosystemLinks="ecosystemLinks" home-link="/arrete-cadre" />
  <DsfrModal :opened="modalSchemeOpened" title="Paramètres d'affichage" :actions="modalActions" @close="closeModal">
    <SchemeForm ref="schemeFormRef" />
  </DsfrModal>
</template>

<style lang="scss">
.fr-header__menu-list-link {
  z-index: 1000;
  position: absolute;
  top: 100px;
  right: -1000px;

  ul {
    list-style-type: none;

    li {
      padding: 0;
    }
  }

  a:not([href]) {
    color: inherit;

    &:hover {
      background-color: var(--hover-tint);
      --underline-hover-width: var(--underline-max-width);
    }
  }
}

@media (min-width: 62em) {
  .fr-header {
    .fr-nav {
      display: none;
    }
  }
}

@media (max-width: 62em) {
  .fr-header {
    .fr-header__menu-links {
      display: none;
    }
  }
}
</style>
