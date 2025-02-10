<script setup lang="ts">
import type { Ref } from 'vue';
import { ArreteRestriction } from '~/dto/arrete_restriction.dto';
import { useAuthStore } from '~/stores/auth';
import { useRefDataStore } from '~/stores/refData';

const props = defineProps<{
  duplicate?: boolean;
}>();

const arreteRestriction: Ref<ArreteRestriction> = ref();

const route = useRoute();
const api = useApi();
const isNewArreteRestriction = route.params.id === 'nouveau';
const authStore = useAuthStore();
const refDataStore = useRefDataStore();

if (isNewArreteRestriction && !route.query.arreterestriction) {
  const newAr = new ArreteRestriction();
  if (route.query.arretecadre) {
    const { data, error } = await api.arreteCadre.get(route.query.arretecadre.toString());
    if (data.value) {
      newAr.arretesCadre = [data.value];
      newAr.departement = authStore.user?.role === 'departement' ?
        refDataStore.departements.find((d) => authStore.user?.roleDepartements.includes(d.code)) :
        data.value?.departements[0];
    }
  }
  arreteRestriction.value = newAr;
} else {
  const { data, error } = await api.arreteRestriction.get(
    isNewArreteRestriction && route.query.arreterestriction ? <string>route.query.arreterestriction : <string>route.params.id,
  );
  if (data.value) {
    const ar = <ArreteRestriction>JSON.parse(JSON.stringify(data.value));
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
    } else if (ar.restrictions.some((r) => r.isAep) && ar.restrictions.some((r) => !r.isAep) ||
      ar.ressourceEapCommunique) {
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
      ar.arreteRestrictionAbroge = <ArreteRestriction>{
        id: data.value.id,
        numero: data.value.numero,
      };
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
      if(!route.query.arreterestriction) {
        ar.arreteRestrictionAbroge = null;
      }
    }
    arreteRestriction.value = ar;
  }
}
</script>

<template>
  <h1>
    {{ duplicate ? 'Duplication' : isNewArreteRestriction ? 'Création' : 'Edition' }} d'un arrêté de restriction
    <MixinsStatutBadge :statut="arreteRestriction.statut" />
  </h1>
  <ArreteRestrictionFormWrapper v-if="arreteRestriction" :arreteRestriction="arreteRestriction" />
</template>
