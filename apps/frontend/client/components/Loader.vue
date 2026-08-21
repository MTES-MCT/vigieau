<script setup lang="ts">
withDefaults(defineProps<{
  announce?: boolean;
  label?: string;
  show: boolean;
}>(), {
  announce: true,
  label: 'Chargement en cours',
});
</script>

<template>
  <Transition>
    <div
      v-if="show"
      class="loader"
      :role="announce ? 'status' : undefined"
      :aria-live="announce ? 'polite' : undefined"
      :aria-atomic="announce ? 'true' : undefined"
    >
      <span v-if="announce" class="fr-sr-only">{{ label }}</span>
      <span class="lds-ring" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
        <span></span>
      </span>
    </div>
  </Transition>
</template>

<style lang="scss">
.lds-ring {
  display: inline-block;
  position: relative;
  width: 24px;
  height: 24px;

  > span {
    box-sizing: border-box;
    display: block;
    position: absolute;
    width: 20px;
    height: 20px;
    margin: 2px;
    border: 2px solid var(--blue-france-sun-113-625);
    border-radius: 50%;
    animation: lds-ring 1.2s cubic-bezier(0.5, 0, 0.5, 1) infinite;
    border-color: var(--blue-france-sun-113-625) transparent transparent transparent;

    &:nth-child(1) {
      animation-delay: -0.45s;
    }

    &:nth-child(2) {
      animation-delay: -0.3s;
    }

    &:nth-child(3) {
      animation-delay: -0.15s;
    }
  }
}

@keyframes lds-ring {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

.v-enter-active,
.v-leave-active {
  transition: opacity 0.5s ease;
}

.v-enter-from,
.v-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .lds-ring > span {
    animation-duration: 0.01ms;
    animation-iteration-count: 1;
  }

  .v-enter-active,
  .v-leave-active {
    transition: none;
  }
}
</style>
