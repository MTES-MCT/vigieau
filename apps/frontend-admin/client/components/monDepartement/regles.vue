<script setup lang="ts">
import { helpers, required } from '@vuelidate/validators/dist';
import useVuelidate from '@vuelidate/core';
import { Parametres } from '~/dto/parametres.dto';
import type { Ref } from 'vue';

const props = defineProps<{
  parametres: Parametres
}>();

const rules = computed(() => {
  return {
    superpositionCommune: {
      required: helpers.withMessage('La règle de gestion à l\'échelle communale est obligatoire.', required),
    },
  };
});

const utils = useUtils();

const regleGestionSuperpositionCommuneOptions = [
  {
    label:
      'Nous ne sommes pas concernés car une commune ne peut pas être concernée par plusieurs zones d\'alerte',
    value: 'no',
    img: null,
  },
  {
    label:
      'Non, les restrictions s\'appliquent à la zone d\'alerte pour l\'ESU, l\'ESO et l\'AEP',
    value: 'no_all',
    img: null,
  },
  {
    label: 'Le niveau maximal s\'applique à la commune pour l’AEP mais les niveaux ESU et ESO s\'appliquent à la zone d\'alerte',
    value: 'yes_only_aep',
    img: '/regles_commune_yes_only_aep.png',
  },
  {
    label: 'Un niveau unique; le plus restrictif parmi ESU, ESO et AEP; s\'applique à la commune pour toutes les ressources (1 niveau unique ESU-ESO-AEP)',
    value: 'yes_all',
    img: '/regles_commune_yes_all.png',
  },
  {
    label: 'Un niveau unique, le plus restrictif parmi ESU et ESO, s\'applique à la commune pour les milieux naturels (1 niveau unique ESU-ESO) et le niveau AEP est distinct',
    value: 'yes_except_aep',
    img: '/regles_commune_yes_except_aep.png',
  },
  {
    label:
      'Le niveau maximal s\'applique à la commune pour chaque type de ressource (1 niveau ESU, 1 niveau AEP, 1 niveau ESO)',
    value: 'yes_distinct',
    img: '/regles_commune_yes_distinct.png',
  },
];

const modalOpened = ref(false);
const modalTitle: Ref<string> = ref(`Schéma explicatif`);
const modalImg: Ref<string> = ref('');
const modalActions: Ref<any[]> = ref([
  {
    label: 'Fermer',
    secondary: true,
    onClick: () => {
      utils.closeModal(modalOpened);
    },
  },
]);

const v$ = useVuelidate(rules, props.parametres);
const expandedId = ref();

defineExpose({
  v$,
});
</script>

<template>
  <form @submit.prevent="">
    <h6>Règle de gestion des niveaux de restrictions</h6>
    <DsfrInputGroup :error-message="utils.showInputError(v$, 'superpositionCommune')">
      <p>Ce paramètre détermine le calcul des niveaux de restrictions affiché sur Vigieau pour chaque type de ressource (eaux souterraines, eaux superficielles, eau potable).</p>
      <fieldset class="fr-fieldset">
        <legend class="fr-fieldset__legend fr-fieldset__legend--regular">
          Si une commune est concernée par plusieurs zones d’alerte, appliquez-vous le niveau de gravité maximal à l'échelle de la commune ? *
        </legend>
        <div class="fr-grid-row fr-grid-row--gutters">
          <template v-for="option in regleGestionSuperpositionCommuneOptions">
            <div class="fr-col-12 fr-col-lg-6">
              <DsfrRadioButton
                :value="option.value"
                name="superpositionCommune"
                v-model="parametres.superpositionCommune"
                :label="option.label"
                :data-cy="`ArreteCadreFormCommuneRadio${option.value}`"
              />
            </div>
            <div class="fr-col-12 fr-col-lg-6">
              <DsfrButton v-if="option.img"
                          class="fr-mb-2w"
                          icon="ri-information-line"
                          label="Voir le schéma explicatif"
                          tertiary
                          @click="modalImg = option.img; modalOpened = true" />
            </div>
          </template>
        </div>
      </fieldset>
    </DsfrInputGroup>
  </form>

  <DsfrModal :opened="modalOpened"
             :title="modalTitle"
             :actions="modalActions"
             size="xl"
             @close="modalOpened = utils.closeModal(modalOpened)">
    <img :src="modalImg" />
  </DsfrModal>
</template>

<style lang="scss" scoped>
img {
  width: 100%;
}
</style>
