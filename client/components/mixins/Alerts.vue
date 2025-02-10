<script setup lang="ts">
import { useAlertStore } from "~/stores/alert";

const alertStore = useAlertStore();

onUnmounted(() => {
  // alertStore.clearAll();
});
</script>

<template>
  <div class="alert-wrapper">
    <template v-for="alert of alertStore.alerts">
      <DsfrAlert
        v-if="alert"
        :type="alert.type"
        :title="alert.title"
        :description="alert.description"
        :small="!alert.title"
        :closeable="true"
        @close="alertStore.clearAlert(alert.id)"
      />
    </template>    
  </div>
</template>

<style lang="scss">
.alert-wrapper {
position: fixed;
  top: 20px;
  right: 20px;
  z-index: 9999;
  width: 50vw;
  gap: 1rem;
  margin: 0 auto;
  
  .fr-alert {
    background-color: var(--background-default-grey);
  }
}
</style>