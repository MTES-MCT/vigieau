<script setup lang="ts">
import { ArreteCadre } from '~/dto/arrete_cadre.dto';
import { captureClientError, getApiErrorMessage } from '~/composables/useApiErrorHandler';
import { useRetryableLoad } from '~/composables/useRetryableLoad';
import { useAuthStore } from '~/stores/auth';

const props = defineProps<{
  duplicate?: boolean;
}>();

const route = useRoute();
const api = useApi();
const authStore = useAuthStore();
const isNewArreteCadre = route.params.id === 'nouveau';

const {
  data: arreteCadre,
  error: loadError,
  loading,
  load,
} = useRetryableLoad(
  async () => {
    if (isNewArreteCadre && !route.query.arretecadre) {
      return new ArreteCadre();
    }
    const { data, error } = await api.arreteCadre.get(
      isNewArreteCadre && route.query.arretecadre ? (route.query.arretecadre as string) : (route.params.id as string),
    );
    if (error.value || !data.value) {
      throw error.value || new Error('L’arrêté-cadre demandé n’a pas été renvoyé par l’API.');
    }
    const ac = JSON.parse(JSON.stringify(data.value)) as ArreteCadre;
    if (props.duplicate || route.query.arretecadre) {
      ac.id = null;
      ac.numero = '';
      ac.statut = 'a_valider';
      ac.dateDebut = null;
      ac.dateFin = null;
      ac.fichier = null;
      ac.arreteCadreAbroge = null;
      ac.usages.map((u) => {
        u.id = null;
        return u;
      });
      ac.zonesAlerte = ac.zonesAlerte.filter((za) => !za.disabled);
    }
    if (route.query.arretecadre) {
      ac.arreteCadreAbroge = {
        id: data.value.id,
        numero: data.value.numero,
      } as ArreteCadre;
    }
    if (ac.departements.length > 1 && ac.departementPilote?.code) {
      const depPiloteIndex = ac.departements.findIndex((d) => d.code === ac.departementPilote.code);
      const depPilote = ac.departements[depPiloteIndex];
      ac.departements.splice(depPiloteIndex, 1);
      ac.departements.splice(0, 0, depPilote);
    }
    return ac;
  },
  (error) =>
    captureClientError(error, {
      action: 'load',
      entity: 'arrete_cadre',
    mode: props.duplicate ? 'duplication' : isNewArreteCadre ? 'creation' : 'edition',
    departement: authStore.user?.roleDepartements?.length === 1 ? authStore.user.roleDepartements[0] : undefined,
    }),
);

void load();
</script>

<template>
  <h1>
    {{ duplicate ? 'Duplication' : isNewArreteCadre ? 'Création' : 'Edition' }} d'un arrêté cadre
    <MixinsStatutBadge v-if="arreteCadre" :statut="arreteCadre.statut" />
  </h1>
  <p v-if="loading" role="status" data-cy="ArreteLoadPending">
    Chargement de l’arrêté en cours.
  </p>
  <template v-else-if="loadError">
    <DsfrAlert title="Chargement de l’arrêté impossible" type="error" class="fr-mb-2w" data-cy="ArreteLoadError">
      {{ getApiErrorMessage(loadError) }}
    </DsfrAlert>
    <ul class="fr-btns-group fr-btns-group--inline-md">
      <li><DsfrButton label="Réessayer" icon="ri-refresh-line" data-cy="ArreteLoadRetry" @click="load" /></li>
      <li><DsfrButton label="Retour à la liste" icon="ri-arrow-left-line" secondary @click="navigateTo('/arrete-cadre')" /></li>
    </ul>
  </template>
  <ArreteCadreFormWrapper v-if="arreteCadre" :arrete-cadre="arreteCadre" />
</template>
