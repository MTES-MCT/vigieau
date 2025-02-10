<script setup lang="ts">
import type { Ref } from "vue";

const props = defineProps<{
  viewOnly: boolean;
  html: string | null;
  onClickEdit: Function;
}>();

const utils = useUtils();
const modalOpened: Ref<boolean> = ref(false);
const modalActions: Ref<any[]> = ref(
  props.viewOnly ?  [] :[{
    label: 'Modifier',
    onclick: () => {
      modalOpened.value = false;
      props.onClickEdit();
    },
  }]
);
modalActions.value.push({
  label: 'Fermer',
  secondary: true,
  onclick: () => {
    utils.closeModal(modalOpened);
  },
})

const lengthTruncated = 200;
const htmlTruncated = computed(() => {
  return props.html?.length > lengthTruncated ? props.html.substring(0, lengthTruncated) + '...' : props.html;
});

const buttons = props.viewOnly ? [] : [
  {
    icon: 'ri-edit-2-fill',
    iconOnly: true,
    label: 'Editer',
    onClick: props.onClickEdit,
  },
];

if(props.html?.length > lengthTruncated) {
  buttons.unshift({
    icon: 'ri-eye-fill',
    iconOnly: true,
    label: 'Consulter',
    onClick: () => {
      modalOpened.value = true
    },
  })
}
</script>

<template>
  <div class="arrete-cadre-recapitulatif-cell">
    <div v-if="htmlTruncated" v-html="htmlTruncated">
    </div>
    <div v-else class="text-align-center">
      <VIcon name="ri-alert-fill" /><br/>
      Champ vide
    </div>
    <div class="arrete-cadre-recapitulatif-cell__hover">
      <DsfrButtonGroup 
        inlineLayoutWhen="always" 
        :buttons="buttons"/>   
    </div>
  </div>
  <DsfrModal :opened="modalOpened"
             :actions="modalActions"
             @close="modalOpened = utils.closeModal(modalOpened);">
    <div v-html="html" />
  </DsfrModal>
</template>

<style scoped lang="scss">
.arrete-cadre-recapitulatif-cell {
  position: relative;

  &:hover {
    & > *:first-child {
      opacity: 0.5;
    }
    
    .arrete-cadre-recapitulatif-cell__hover {
      visibility: visible;
    }
  }
  
  &__hover {
    position: absolute;
    width: 100%;
    height: 100%;
    top: 0;
    left: 0;
    display: flex;
    align-items: flex-end;
    justify-content: flex-end;
    visibility: hidden;
  }
  
  .ov-icon {
    color: var(--blue-france-sun-113-625);
  }
}
</style>
