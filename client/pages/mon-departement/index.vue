<script setup lang="ts">
import type { Ref } from "vue";
import { useAuthStore } from '~/stores/auth';

definePageMeta({
  layout: 'basic',
  middleware: 'role',
  roles: ['mte', 'departement'],
});

useHead({
  title: `Mon département - ${useRuntimeConfig().public.appName}`,
});

const tabTitles = [
  {title: 'Paramètres'},
  {title: 'Utilisateurs'}
];
const selectedTabIndex: Ref<number> = ref(0);
const utils = useUtils();
const authStore = useAuthStore();

const breadcrumb = [
  {
    to: "/",
    text: "Accueil"
  }, {
    text: "Mon département"
  }
];
</script>

<template>
  <DsfrBreadcrumb :links="breadcrumb" />
  <h1 class="fr-mb-4w">
    Mon département ({{ authStore.user?.firstName }} {{ authStore.user?.lastName }})
  </h1>
  <DsfrTabs :tab-titles="tabTitles"
            :initial-selected-index="selectedTabIndex"
            @select-tab="selectedTabIndex = $event; utils.scrollToTop()">
    <DsfrTabContent
      panel-id="tab-content-0"
      tab-id="tab-0"
      :selected="selectedTabIndex === 0">
      <MonDepartement />
    </DsfrTabContent>
    <DsfrTabContent
      panel-id="tab-content-1"
      tab-id="tab-1"
      :selected="selectedTabIndex === 1">
      <UserList />
    </DsfrTabContent>
  </DsfrTabs>
</template>
