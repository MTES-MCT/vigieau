<script setup lang="ts">
import { ArreteRestriction } from '~/dto/arrete_restriction.dto';
import { useAuthStore } from '~/stores/auth';
import { useRefDataStore } from '~/stores/refData';
import { captureClientError, getApiErrorMessage } from '~/composables/useApiErrorHandler';
import { useRetryableLoad } from '~/composables/useRetryableLoad';

const props = defineProps<{
  duplicate?: boolean;
}>();

const route = useRoute();
const api = useApi();
const isNewArreteRestriction = route.params.id === 'nouveau';
const authStore = useAuthStore();
const refDataStore = useRefDataStore();

const {
  data: arreteRestriction,
  error: loadError,
  loading,
  load,
} = useRetryableLoad(
  async () => {
    if (isNewArreteRestriction && !route.query.arreterestriction) {
      const newAr = new ArreteRestriction();
      if (route.query.arretecadre) {
        const { data, error } = await api.arreteCadre.get(route.query.arretecadre.toString());
        if (error.value || !data.value) {
          throw error.value || new Error('L’arrêté-cadre demandé n’a pas été renvoyé par l’API.');
        }
        newAr.arretesCadre = [data.value];
        newAr.departement =
          authStore.user?.role === 'departement'
            ? refDataStore.departements.find((d) => authStore.user?.roleDepartements.includes(d.code))
            : data.value?.departements[0];
      }
      return newAr;
    }
    const { data, error } = await api.arreteRestriction.get(
      isNewArreteRestriction && route.query.arreterestriction ? (route.query.arreterestriction as string) : (route.params.id as string),
    );
    if (error.value || !data.value) {
      throw error.value || new Error('L’arrêté de restriction demandé n’a pas été renvoyé par l’API.');
    }
    const ar = JSON.parse(JSON.stringify(data.value)) as ArreteRestriction;
    // Format restrictions
    ar.restrictions = ar.restrictions.map((r) => {
      if (!r.zoneAlerte) {
        r.isAep = true;
      }
      return r;
    });
    // Format périmètre AR
    if (ar.restrictions.length < 1) {
      ar.perimetreAr = null;
    } else if ((ar.restrictions.some((r) => r.isAep) && ar.restrictions.some((r) => !r.isAep)) || ar.ressourceEapCommunique) {
      ar.perimetreAr = 'all';
    } else if (ar.restrictions.some((r) => r.isAep)) {
      ar.perimetreAr = 'aep';
      ar.niveauGraviteSpecifiqueEap = null;
      ar.ressourceEapCommunique = null;
    } else {
      ar.perimetreAr = 'zones';
      ar.niveauGraviteSpecifiqueEap = null;
      ar.ressourceEapCommunique = null;
    }
    if (route.query.arreterestriction) {
      ar.arreteRestrictionAbroge = {
        id: data.value.id,
        numero: data.value.numero,
      } as ArreteRestriction;
    }
    if (props.duplicate || route.query.arreterestriction) {
      ar.id = null;
      ar.numero = '';
      ar.statut = 'a_valider';
      ar.dateDebut = null;
      ar.dateFin = null;
      ar.dateSignature = null;
      ar.fichier = null;
      ar.restrictions = ar.restrictions.filter((r) => {
        return !r.zoneAlerte || !r.zoneAlerte.disabled;
      });
      ar.restrictions.map((r) => {
        r.id = null;
        r.usages.map((u) => {
          u.id = null;
          return u;
        });
        return r;
      });
      if (!route.query.arreterestriction) {
        ar.arreteRestrictionAbroge = null;
      }
    }
    return ar;
  },
  (error) =>
    captureClientError(error, {
      action: 'load',
      entity: 'arrete_restriction',
      mode: props.duplicate ? 'duplication' : isNewArreteRestriction ? 'creation' : 'edition',
      departement: authStore.user?.roleDepartements?.length === 1 ? authStore.user.roleDepartements[0] : undefined,
    }),
);

void load();
</script>

<template>
  <h1>
    {{ duplicate ? 'Duplication' : isNewArreteRestriction ? 'Création' : 'Edition' }} d'un arrêté de restriction
    <MixinsStatutBadge v-if="arreteRestriction" :statut="arreteRestriction.statut" />
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
      <li><DsfrButton label="Retour à la liste" icon="ri-arrow-left-line" secondary @click="navigateTo('/arrete-restriction')" /></li>
    </ul>
  </template>
  <ArreteRestrictionFormWrapper v-if="arreteRestriction" :arrete-restriction="arreteRestriction" />
</template>
