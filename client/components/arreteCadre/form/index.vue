<script setup lang="ts">
import { ArreteCadre } from '~/dto/arrete_cadre.dto';
import type { Ref } from 'vue';

const props = defineProps<{
  duplicate?: boolean;
}>();

const arreteCadre: Ref<ArreteCadre> = ref();

const route = useRoute();
const api = useApi();
const isNewArreteCadre = route.params.id === 'nouveau';

if (isNewArreteCadre && !route.query.arretecadre) {
  arreteCadre.value = new ArreteCadre();
} else {
  const { data, error } = await api.arreteCadre.get(isNewArreteCadre && route.query.arretecadre ?
    <string>route.query.arretecadre : <string>route.params.id);
  if (data.value) {
    const ac = <ArreteCadre>JSON.parse(JSON.stringify(data.value));
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
      ac.zonesAlerte = ac.zonesAlerte.filter(za => !za.disabled);
    }
    if(route.query.arretecadre) {
      ac.arreteCadreAbroge = <ArreteCadre>{
        id: data.value.id,
        numero: data.value.numero
      };
    }
    if (ac.departements.length > 1 && ac.departementPilote?.code) {
      const depPiloteIndex = ac.departements.findIndex((d) => d.code === ac.departementPilote.code);
      const depPilote = ac.departements[depPiloteIndex];
      ac.departements.splice(depPiloteIndex, 1);
      ac.departements.splice(0, 0, depPilote);
    }
    arreteCadre.value = ac;
  }
}
</script>

<template>
  <h1>
    {{ duplicate ? 'Duplication' : isNewArreteCadre ? 'Création' : 'Edition' }} d'un arrêté cadre
    <MixinsStatutBadge :statut="arreteCadre.statut" />
  </h1>
  <ArreteCadreFormWrapper v-if="arreteCadre" :arreteCadre="arreteCadre" />
</template>
