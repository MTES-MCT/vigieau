<script setup lang="ts">
import type { Ref } from 'vue';
import type { ArreteCadre } from '~/dto/arrete_cadre.dto';
import { ArreteCadreStatutFr } from '~/dto/arrete_cadre.dto';
import { useAuthStore } from '~/stores/auth';
import { useAlertStore } from '~/stores/alert';
import { useContextStore } from '~/stores/context';

const props = defineProps<{
  arreteCadre: ArreteCadre;
}>();

const emit = defineEmits<{
  delete: any;
  repeal: any;
}>();

const authStore = useAuthStore();
const alertStore = useAlertStore();
const contextStore = useContextStore();
const utils = useUtils();
const isAcOnDepartementUser: boolean =
  authStore.isMte || props.arreteCadre.departements.some((d) => authStore.user?.roleDepartements.includes(d.code));
const isZaOutdated: boolean = props.arreteCadre.statut !== 'abroge' && props.arreteCadre.zonesAlerte.some((za) => za.disabled);
const canUpdate = authStore.isMte || (props.arreteCadre.statut !== 'abroge' && isAcOnDepartementUser && !isZaOutdated);
const arreteCadreStatutFr = ArreteCadreStatutFr;
const actionsOpened: Ref<boolean> = ref(false);
const arreteCadreActions: Ref<any> = ref([
  {
    text: props.arreteCadre.statut === 'a_valider' ? 'Modifier' : 'Corriger',
    show: canUpdate,
    onclick: () => {
      utils.askEditArreteCadre(props.arreteCadre, modalTitle, modalDescription, modalActions, modalOpened, editArreteCadre);
    },
  },
  {
    text: 'Dupliquer',
    onclick: () => {
      navigateTo(`/arrete-cadre/${props.arreteCadre.id}/duplication`);
    },
    show: ['a_valider', 'abroge'].includes(props.arreteCadre.statut) && isAcOnDepartementUser,
  },
  {
    text: 'Créer un arrêté de restriction associé',
    show: ['a_venir', 'publie'].includes(props.arreteCadre.statut) && isAcOnDepartementUser && !isZaOutdated,
    onclick: () => {
      navigateTo(`/arrete-restriction/nouveau/edition?arretecadre=${props.arreteCadre.id}`);
    },
  },
  // {
  //   text: 'Exporter',
  //   onclick: () => {
  //     console.log('click');
  //   },
  // },
  {
    text: `Abroger l'arrêté et le remplacer`,
    show: ['a_venir', 'publie'].includes(props.arreteCadre.statut) && isAcOnDepartementUser,
    onclick: () => {
      navigateTo(`/arrete-cadre/nouveau/edition?arretecadre=${props.arreteCadre.id}`);
    },
  },
  {
    text: `Abroger`,
    show: ['a_venir', 'publie'].includes(props.arreteCadre.statut) && isAcOnDepartementUser,
    onclick: () => {
      repealModalOpened.value = true;
    },
  },
  {
    text: 'Supprimer',
    show: authStore.isMte || (props.arreteCadre.arretesRestriction.length < 1 && isAcOnDepartementUser),
    onclick: () => {
      askDeleteArreteCadre(props.arreteCadre);
    },
  },
]);

const arEnVigueurSameDepartement = computed(() => {
  return props.arreteCadre.arretesRestriction?.filter(
    (ar) => ['a_venir', 'publie'].includes(ar.statut) &&
      (authStore.user?.role === 'mte' || (ar.departement && authStore.user?.roleDepartements.includes(ar.departement.code))),
  );
});
const arEnVigueurOtherDepartement = computed(() => {
  return props.arreteCadre.arretesRestriction?.filter(
    (ar) => ['a_venir', 'publie'].includes(ar.statut) &&
      authStore.user?.role !== 'mte' && ar.departement && !authStore.user?.roleDepartements.includes(ar.departement.code),
  );
});

const onKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    actionsOpened.value = false;
  }
};

const onDocumentClick = (e: MouseEvent) => {
  handleElementClick(e.target as HTMLElement);
};

const handleElementClick = (el: HTMLElement) => {
  if (el === document.getElementById(`action_${props.arreteCadre.id}`)) {
    return;
  }

  if (!el?.parentNode) {
    actionsOpened.value = false;
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

const api = useApi();
const askDeleteArreteCadre = async (arreteCadre: ArreteCadre) => {
  modalActions.value = [
    {
      label: 'Confirmer',
      onclick: () => {
        deleteArreteCadre(arreteCadre.id);
      },
    },
    {
      label: 'Annuler',
      secondary: true,
      onclick: () => {
        utils.closeModal(modalOpened);
      },
    },
  ];
  modalTitle.value = `Suppression d’un arrêté cadre`;
  modalDescription.value = `Vous confirmez que la suppression de cet arrêté cadre est justifiée par une erreur de saisie.`;
  if (arreteCadre.arretesRestriction.length > 0) {
    modalDescription.value += `<br/><br/>Les arrêtés de restriction suivant seront supprimés&nbsp;:`;
    arreteCadre.arretesRestriction.forEach((ar) => {
      modalDescription.value += `<br/>${ar.numero} - ${arreteCadreStatutFr[ar.statut]}`;
    });
  }
  modalOpened.value = true;
};

const deleteArreteCadre = async (id: string) => {
  if (loading.value) {
    return;
  }
  loading.value = true;
  const { data, error } = await api.arreteCadre.delete(id);
  if (!error.value) {
    emit('delete');
  }
  utils.closeModal(modalOpened);
  loading.value = false;
};

// Permet de faire un retour à la ligne sur les underscores
const numeroToDisplay = computed(() => {
  let num = props.arreteCadre.numero;
  num = num?.replace(/_/g, '_<wbr/>');
  return num;
});

const editArreteCadre = (id: string) => {
  utils.closeModal(modalOpened);
  navigateTo(`/arrete-cadre/${id}/edition`);
};

const modalOpened: Ref<boolean> = ref(false);
const modalTitle: Ref<string> = ref('');
const modalDescription: Ref<string> = ref('');
const modalActions: Ref<any[]> = ref([]);

const abrogerFormRef = ref(null);
const loading = ref(false);
const repealModalOpened: Ref<boolean> = ref(false);
const repealModalActions: Ref<any[]> = ref([
  {
    label: 'Abroger',
    'data-cy': 'RepealFormRepealBtn',
    onclick: () => {
      abrogerFormRef.value?.submitForm();
    },
  },
  {
    label: 'Annuler',
    secondary: true,
    onclick: () => {
      utils.closeModal(repealModalOpened);
    },
  },
]);

const repealArrete = async (ac: ArreteCadre) => {
  if (loading.value) {
    return;
  }
  loading.value = true;
  const { data, error } = await api.arreteCadre.repeal(ac.id?.toString(), ac);
  if (!error.value) {
    utils.closeModal(repealModalOpened);
    emit('repeal');
    alertStore.addAlert({
      description: 'Abrogation réussie',
      type: 'success',
    });
  }
  loading.value = false;
};

const goToArs = () => {
  if (props.arreteCadre.departements?.length > 1) {
    contextStore.setDepartementFilter(0);
  }
  navigateTo(`/arrete-restriction?query=${props.arreteCadre.numero}`);
};

const depString = computed(() => {
  return props.arreteCadre.departements.map((d) => d.nom).join('&nbsp;; ');
});
</script>

<template>
  <div class="fr-card" data-cy="ArreteCadreListCard">
    <div class="fr-card__body">
      <div class="fr-card__content">
        <h3 class="fr-card__title">
          <NuxtLink
            :to="`/arrete-cadre/${arreteCadre.id}${arreteCadre.statut === 'a_valider' && canUpdate ? '/edition' : ''}`"
            v-html="numeroToDisplay"
          ></NuxtLink>
        </h3>
        <p class="fr-card__desc">Dep&nbsp;: <span v-html="depString" /></p>
        <div class="fr-card__start">
          <ul class="fr-badges-group">
            <li v-if="isZaOutdated">
              <DsfrBadge label="Zones d’alerte modifiées" type="warning" />
            </li>
            <li>
              <MixinsStatutBadge :statut="arreteCadre.statut" />
            </li>
          </ul>
          <p class="fr-card__detail">
            <VIcon name="ri-calendar-fill" />
            &nbsp;
            {{ utils.formatDate(arreteCadre.dateDebut) }}
            <span v-if="arreteCadre.dateFin"> &nbsp;au {{ utils.formatDate(arreteCadre.dateFin) }} </span>
          </p>
          <div :id="'action_' + arreteCadre.id" class="fr-card__actions" v-if="arreteCadreActions.some((a: any) => a.show)">
            <DsfrButton
              label="Actions"
              data-cy="ArreteCadreCardActionsBtn"
              icon-only
              secondary
              icon="ri-more-2-fill"
              @click="actionsOpened = !actionsOpened"
            />
            <div v-if="actionsOpened" class="fr-card__actions__menu">
              <div class="fr-menu">
                <ul class="fr-menu__list">
                  <template v-for="action of arreteCadreActions">
                    <li v-if="action.show">
                      <a
                        class="fr-nav__link"
                        @click="
                          action.onclick();
                          actionsOpened = false;
                        "
                      >
                        {{ action.text }}
                      </a>
                    </li>
                  </template>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="fr-card__footer fr-grid-row" v-if="arreteCadre.arretesRestriction.length > 0">
        <a
          @click="goToArs()"
          v-if="arEnVigueurSameDepartement.length > 0"
          class="fr-link fr-icon-arrow-right-line fr-link--icon-right"
        >
          {{ arEnVigueurSameDepartement.length }} arrêté(s) de restriction en vigueur
        </a>
        <NuxtLink
          disabled
          v-if="arEnVigueurOtherDepartement.length > 0"
          class="fr-link"
        >
          {{ arEnVigueurOtherDepartement.length }} arrêté(s) de restriction en vigueur sur d'autres départements
        </NuxtLink>
        <!--        <NuxtLink-->
        <!--          :to="'/arrete-restriction?query=' + arreteCadre.numero"-->
        <!--          v-if="arBrouillon.length > 0"-->
        <!--          class="fr-link fr-icon-arrow-right-line fr-link&#45;&#45;icon-right"-->
        <!--        >-->
        <!--          {{ arBrouillon.length }} arrêté(s) de restriction brouillon(s)-->
        <!--        </NuxtLink>-->
        <!--        <NuxtLink-->
        <!--          :to="'/arrete-restriction?query=' + arreteCadre.numero"-->
        <!--          v-if="arAbroges.length > 0"-->
        <!--          class="fr-link fr-icon-arrow-right-line fr-link&#45;&#45;icon-right"-->
        <!--        >-->
        <!--          {{ arAbroges.length }} arrêté(s) de restriction abrogé(s)-->
        <!--        </NuxtLink>-->
      </div>
    </div>
  </div>
  <DsfrModal :opened="modalOpened"
             icon="ri-arrow-right-line"
             :title="modalTitle"
             :actions="modalActions"
             @close="modalOpened = utils.closeModal(modalOpened);">
    <div v-html="modalDescription"></div>
  </DsfrModal>
  <DsfrModal
    :opened="repealModalOpened"
    icon="ri-arrow-right-line"
    :title="`Abroger l'arrêté ${arreteCadre.numero}`"
    :actions="repealModalActions"
    @close="repealModalOpened = utils.closeModal(repealModalOpened);"
  >
    <ArreteCadreFormAbroger ref="abrogerFormRef" :arrete-cadre="arreteCadre" @abroger="repealArrete($event)" />
  </DsfrModal>
</template>

<style lang="scss" scoped>
.fr-badge--restrictions {
  background-color: var(--purple-glycine-950-100);
  color: var(--purple-glycine-sun-319-moon-630);
}

.fr-card {
  &__actions {
    position: absolute;
    top: 2rem;
    right: 2rem;

    &__menu {
      z-index: 1;
      position: absolute;
      top: 40px;

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
  }
  
  &__footer {
    a {
      color: var(--text-action-high-blue-france);
      background-image: var(--underline-img), var(--underline-img);
      background-position: var(--underline-x) 100%, var(--underline-x) calc(100% - var(--underline-thickness));
      background-repeat: no-repeat, no-repeat;
      background-size: var(--underline-hover-width) calc(var(--underline-thickness)* 2), var(--underline-idle-width) var(--underline-thickness);
      transition: background-size 0s;
      
      &:hover {
        --underline-hover-width: var(--underline-max-width);
      }
    }
  }
}
</style>
