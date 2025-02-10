<script setup lang="ts">
import type { Ref } from "vue";
import { type ArreteRestriction, ArreteRestrictionStatutFr } from "~/dto/arrete_restriction.dto";
import { useAuthStore } from "~/stores/auth";
import { useAlertStore } from "~/stores/alert";

const props = defineProps<{
  arreteRestriction: ArreteRestriction;
}>();

const emit = defineEmits<{
  delete: any;
  repeal: any;
}>();

const authStore = useAuthStore();
const alertStore = useAlertStore();
const utils = useUtils();
const isArOnDepartementUser: boolean = authStore.isMte || authStore.user?.roleDepartements.includes(props.arreteRestriction.departement?.code);
const isZaOutdated: boolean = props.arreteRestriction.statut !== 'abroge' && props.arreteRestriction.restrictions.some((r) => r.zoneAlerte?.disabled);
const canUpdate = authStore.isMte
  || (props.arreteRestriction.statut !== "abroge" && isArOnDepartementUser && !isZaOutdated);
const arreteRestrictionStatutFr = ArreteRestrictionStatutFr;
const actionsOpened: Ref<boolean> = ref(false);
const arreteRestrictionActions: Ref<any> = ref([
  {
    text: props.arreteRestriction.statut === 'a_valider' ? 'Modifier' : 'Corriger',
    show: canUpdate,
    onclick: () => {
      utils.askEditArreteRestriction(props.arreteRestriction, modalTitle, modalDescription, modalActions, modalOpened, editArreteRestriction);
    }
  },
  {
    text: "Dupliquer",
    onclick: () => {
      navigateTo(`/arrete-restriction/${props.arreteRestriction.id}/duplication`);
    },
    show: ['a_valider', 'abroge'].includes(props.arreteRestriction.statut) && isArOnDepartementUser,
  },
  {
    text: `Abroger l'arrêté et le remplacer`,
    show: ['a_venir', 'publie'].includes(props.arreteRestriction.statut) && isArOnDepartementUser,
    onclick: () => {
      navigateTo(`/arrete-restriction/nouveau/edition?arreterestriction=${props.arreteRestriction.id}`);
    },
  },
  {
    text: "Abroger",
    show: ["a_venir", "publie"].includes(props.arreteRestriction.statut) && isArOnDepartementUser,
    onclick: () => {
      repealModalOpened.value = true;
    }
  },
  {
    text: "Supprimer",
    show: authStore.isMte || (isArOnDepartementUser && props.arreteRestriction.statut === "a_valider"),
    onclick: () => {
      askDeleteArreteRestriction(props.arreteRestriction);
    }
  }
  // {
  //   text: 'Exporter',
  //   onclick: () => {
  //     console.log('click');
  //   },
  // },
]);

const onKeyDown = (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    actionsOpened.value = false;
  }
};

const onDocumentClick = (e: MouseEvent) => {
  handleElementClick(e.target as HTMLElement);
};

const handleElementClick = (el: HTMLElement) => {
  if (el === document.getElementById(`action_${props.arreteRestriction.id}`)) {
    return;
  }

  if (!el?.parentNode) {
    actionsOpened.value = false;
    return;
  }

  handleElementClick(el.parentNode as HTMLElement);
};

onMounted(() => {
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onKeyDown);
});
onUnmounted(() => {
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("keydown", onKeyDown);
});

const api = useApi();
const askDeleteArreteRestriction = async (arreteRestriction: ArreteRestriction) => {
  modalActions.value = [
    {
      label: 'Confirmer',
      onclick: () => {
        deleteArreteRestriction(arreteRestriction.id);
      }
    },
    {
      label: 'Annuler',
      secondary: true,
      onclick: () => {
        utils.closeModal(modalOpened);
      }
    }
  ];
  modalTitle.value = `Suppression d’un arrêté de restriction`;
  modalDescription.value = `Vous confirmez que la suppression de cet arrêté de restriction est justifiée par une erreur de saisie.`;
  modalOpened.value = true;
};
const deleteArreteRestriction = async (id: string) => {
  if (loading.value) {
    return;
  }
  loading.value = true;
  const { data, error } = await api.arreteRestriction.delete(id);
  if (!error.value) {
    emit("delete");
  }
  utils.closeModal(modalOpened);
  loading.value = false;
};

// Permet de faire un retour à la ligne sur les underscores
const numeroToDisplay = computed(() => {
  let num = props.arreteRestriction.numero;
  num = num.replace(/_/g, "_<wbr/>");
  return num;
});

const editArreteRestriction = (id: string) => {
  utils.closeModal(modalOpened);
  navigateTo(`/arrete-restriction/${id}/edition`);
};

const modalOpened: Ref<boolean> = ref(false);
const modalTitle: Ref<string> = ref("");
const modalDescription: Ref<string> = ref("");
const modalActions: Ref<any[]> = ref([]);

const abrogerFormRef = ref(null);
const loading = ref(false);
const repealModalOpened: Ref<boolean> = ref(false);
const repealModalActions: Ref<any[]> = ref([
  {
    label: "Abroger",
    "data-cy": "RepealFormRepealBtn",
    onclick: () => {
      abrogerFormRef.value?.submitForm();
    }
  },
  {
    label: "Annuler",
    secondary: true,
    onclick: () => {
      utils.closeModal(repealModalOpened);
    }
  }
]);

const repealArrete = async (ar: ArreteRestriction) => {
  if (loading.value) {
    return;
  }
  loading.value = true;
  const { data, error } = await api.arreteRestriction.repeal(ar.id?.toString(), ar);
  if (!error.value) {
    utils.closeModal(repealModalOpened);
    emit("repeal");
    alertStore.addAlert({
      description: 'Abrogation réussie',
      type: 'success',
    });
  }
  loading.value = false;
};
</script>

<template>
  <div class="fr-card">
    <div class="fr-card__body">
      <div class="fr-card__content">
        <h3 class="fr-card__title">
          <NuxtLink
            :to="`/arrete-restriction/${arreteRestriction.id}${arreteRestriction.statut === 'a_valider' && canUpdate ? '/edition' : ''}`"
            v-html="numeroToDisplay"
          ></NuxtLink>
        </h3>
        <p class="fr-card__desc">Dep&nbsp;: <span>{{ arreteRestriction.departement?.nom }}</span></p>
        <div class="fr-card__start">
          <ul class="fr-badges-group">
            <li v-if="isZaOutdated">
              <DsfrBadge label="Zones d’alerte modifiées" type="warning" />
            </li>
            <li>
              <MixinsStatutBadge :statut="arreteRestriction.statut" />
            </li>
          </ul>
          <p class="fr-card__detail">
            <div class="fr-grid-row">
              <VIcon name="ri-calendar-fill" />
              &nbsp;
              {{ utils.formatDate(arreteRestriction.dateDebut) }}
              <span v-if="arreteRestriction.dateFin"> &nbsp;au {{ utils.formatDate(arreteRestriction.dateFin) }} </span>
              <div class="fr-col-12" v-if="arreteRestriction.dateSignature">
                signé le {{ utils.formatDate(arreteRestriction.dateSignature) }}
              </div>
            </div>
          </p>
          <div :id="'action_' + arreteRestriction.id" class="fr-card__actions"
               v-if="arreteRestrictionActions.some((a: any) => a.show)">
            <DsfrButton 
              label="Actions"
              data-cy="ArreteRestrictionCardActionsBtn"
              icon-only
              secondary 
              icon="ri-more-2-fill" 
              @click="actionsOpened = !actionsOpened" />
            <div v-if="actionsOpened" class="fr-card__actions__menu">
              <div class="fr-menu">
                <ul class="fr-menu__list">
                  <template v-for="action of arreteRestrictionActions">
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
    :title="`Abroger l'arrêté ${arreteRestriction.numero}`"
    :actions="repealModalActions"
    @close="repealModalOpened = utils.closeModal(repealModalOpened);"
  >
    <ArreteRestrictionFormAbroger ref="abrogerFormRef" :arreteRestriction="arreteRestriction" @abroger="repealArrete($event)" />
  </DsfrModal>
</template>

<style lang="scss" scoped>
.fr-badge--restrictions {
  background-color: var(--purple-glycine-950-100);
  color: var(--purple-glycine-sun-319-moon-630);
}

.fr-card__actions {
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
</style>
