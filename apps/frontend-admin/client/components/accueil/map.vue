<script setup lang="ts">
import { useAuthStore } from '~/stores/auth';

const authStore = useAuthStore();

const departementCode = authStore.user?.role === 'departement' && authStore.user.roleDepartements ? 
  authStore.user.roleDepartements[0] : null;
const iframeSrc = departementCode ? `https://${useRuntimeConfig().public.domainName}/carte/?depCode=${departementCode}`
  : `https://${useRuntimeConfig().public.domainName}/carte/`;
</script>

<template>
  <div class="fr-card fr-pt-2w">
    <iframe width="100%" height="700px" :src="iframeSrc"></iframe>
  </div>
</template>