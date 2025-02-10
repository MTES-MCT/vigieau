<script setup lang="ts">
import type { Ref } from 'vue';
import type { PaginatedResult } from '~/dto/paginated_result.dto';
import type { ArreteMunicipal } from '~/dto/arrete_municipal.dto';
import { MixinsStatutBadge } from '#components';
import { useAlertStore } from '~/stores/alert';
import { useAuthStore } from '~/stores/auth';

const arretesMunicipauxPaginated: Ref<PaginatedResult<ArreteMunicipal> | null> = ref(null);
const alertStore = useAlertStore();
const authStore = useAuthStore();
const currentPage = ref(0);
const rows: Ref<any[]> = ref([]);
const loading = ref(false);
const api = useApi();
const utils = useUtils();
const router = useRouter();
const deleteModalOpened: Ref<boolean> = ref(false);
const deleteDescriptionModal: Ref<string> = ref('');
const arreteMunicipalToDelete: Ref<any> = ref(null);

const paginate = async () => {
  loading.value = true;
  const { data, error } = await api.arreteMunicipal.paginate(currentPage.value + 1, undefined, undefined, 10);
  loading.value = false;
  if (data.value) {
    data.value.meta.dsfrPages = Array.from({ length: data.value.meta.totalPages }, (value, index) => {
      return {
        title: `Page ${index + 1}`,
        label: `${index + 1}`,
      };
    });
    arretesMunicipauxPaginated.value = <any>data.value;
    populateTable();
  }
};

const populateTable = () => {
  rows.value = [];
  arretesMunicipauxPaginated.value?.data?.forEach((am: ArreteMunicipal) => {
    rows.value.push(
      [
        am.communes.map(c => {
          return `${c.nom} (${c.code})`;
        }).join(', '),
        {
          component: MixinsStatutBadge,
          statut: am.statut,
        },
        `Du ${utils.formatDate(am.dateDebut)} au ${utils.formatDate(am.dateFin)}`,
        am.fichier ? {
          component: 'DsfrFileDownload',
          format: 'PDF',
          href: am.fichier.url,
          size: utils.fileSizeString(am.fichier.size),
          download: am.fichier.url,
          title: am.fichier.nom,
        } : '',
        am.statut !== 'abroge' ?
        {
          component: 'DsfrButton',
          secondary: true,
          text: 'Modifier',
          onClick: () => {
            router.push(`/arrete-municipal/${am.id}/edition`);
          },
        } : '',
        authStore.user && authStore.user.role !== 'commune' ?
          {
            component: 'DsfrButton',
            secondary: true,
            text: 'Supprimer',
            onClick: () => {
              arreteMunicipalToDelete.value = am;
              deleteDescriptionModal.value = `<p>Êtes-vous sûr de vouloir supprimer l'arrêté municipal ?<br/>
Cette action est irréversible.</p>`;
              deleteModalOpened.value = true;
            },
          } : '',
      ],
    );
  });
};

const deleteArrete = async () => {
  if (loading.value) {
    return;
  }
  loading.value = true;
  const { data, error } = await api.arreteMunicipal.delete(arreteMunicipalToDelete.value.id?.toString());
  if (!error.value) {
    utils.closeModal(deleteModalOpened);
    alertStore.addAlert({
      description: 'Suppression réussie',
      type: 'success',
    });
  }
  loading.value = false;
  paginate();
};

const headers = ['Communes', 'Statut', 'Dates', 'Arrêté municipal', '', ''];

paginate();
</script>

<template>
  <div class="fr-grid-row fr-grid-row--space-between fr-grid-row--middle fr-mb-2w">
    <h1 class="fr-my-0">
      Les arrêtés municipaux

      <VIcon v-if="loading" name="ri-loader-4-line" animation="spin" :width="40" :height="40" />
    </h1>
    <NuxtLink to="/arrete-municipal/nouveau/edition">
      <DsfrButton label="Créer un nouvel arrêté municipal" data-cy="ArreteMunicipalListAddBtn" />
    </NuxtLink>
    <div class="fr-col-12">
      Vous pouvez gérer ici vos arrêtés municipaux sécheresse.
    </div>
  </div>
  <template v-if="arretesMunicipauxPaginated">
    <DsfrTable title=""
               :headers="headers"
               :rows="rows"
               :pagination="false" />
    <div class="fr-grid-row fr-grid-row--center fr-mt-2w">
      <DsfrPagination
        v-model:current-page="currentPage"
        :pages="arretesMunicipauxPaginated.meta.dsfrPages"
        @update:current-page="paginate()"
      />
    </div>
  </template>
  <MixinsConfirmationModal
    :opened="deleteModalOpened"
    title="Supprimer l'arrêté municipal"
    :description="deleteDescriptionModal"
    @close="deleteModalOpened = utils.closeModal(deleteModalOpened)"
    @confirm="deleteArrete()"
  />
</template>