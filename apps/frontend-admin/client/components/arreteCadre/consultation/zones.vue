<script setup lang="ts">
import type { ArreteCadre } from '~/dto/arrete_cadre.dto';
import { useRefDataStore } from '~/stores/refData';
import type { Ref } from 'vue';
import type { ZoneAlerte } from '~/dto/zone_alerte.dto';

const props = defineProps<{
  arreteCadre: ArreteCadre;
}>();

const refDataStore = useRefDataStore();

const departementsFiletered: Ref<any[]> = ref([]);
const expandedId = ref();

const getZonesByType = (zones: ZoneAlerte[], type: string, ressourceInfluencee?: boolean) => {
  return zones.filter((z) => z.type === type && (ressourceInfluencee !== undefined ? z.ressourceInfluencee === ressourceInfluencee : true));
};

watch(
  () => refDataStore.departements,
  () => {
    departementsFiletered.value = refDataStore.departements
      .filter((d) => props.arreteCadre.departements.map((ad) => ad.id).includes(d.id))
      .map((d) => {
        return {
          id: d.id,
          nom: d.nom,
          zonesAlerte: props.arreteCadre.zonesAlerte.filter((za) => za.departement.id === d.id),
        };
      });
  },
  { immediate: true },
);
</script>

<template>
  <template v-for="(d, dIndex) of departementsFiletered" :key="dIndex">
    <h2>Zones d'alerte du {{ d.nom }} ({{ d.zonesAlerte.length }})</h2>
    <template v-if="getZonesByType(d.zonesAlerte, 'SUP').length > 0">
      <p><b>Eaux superficielles</b></p>
      <p v-for="(za, zaIndex) of getZonesByType(d.zonesAlerte, 'SUP', false)" :key="zaIndex" class="fr-ml-2w fr-my-2w">
        {{ za.code }} {{ za.nom }}
      </p>
      <p v-if="getZonesByType(d.zonesAlerte, 'SUP', true).length > 0">&ensp;<u>Ressources influencées</u></p>
      <p v-for="(za, zaIndex) of getZonesByType(d.zonesAlerte, 'SUP', true)" :key="zaIndex" class="fr-ml-2w fr-my-2w">
        {{ za.code }} {{ za.nom }}
        <DsfrAccordion
          v-if="za.communes?.length > 0"
          class="fr-accordion--no-shadow fr-mt-1w"
          :title="`Voir les ${za.communes.length} communes`"
          :expanded-id="expandedId"
          @expand="expandedId = $event"
        >
          <span v-for="(c, cIndex) of za.communes" :key="cIndex"> {{ c.code }} - {{ c.nom }}<br /> </span>
        </DsfrAccordion>
      </p>
    </template>
    <template v-if="getZonesByType(d.zonesAlerte, 'SOU').length > 0">
      <p><b>Eaux souterraines</b></p>
      <p v-for="(za, zaIndex) of getZonesByType(d.zonesAlerte, 'SOU', false)" :key="zaIndex" class="fr-ml-2w fr-my-2w">
        {{ za.code }} {{ za.nom }}
      </p>
      <p v-if="getZonesByType(d.zonesAlerte, 'SOU', true).length > 0">&ensp;<u>Ressources influencées</u></p>
      <p v-for="(za, zaIndex) of getZonesByType(d.zonesAlerte, 'SOU', true)" :key="zaIndex" class="fr-ml-2w fr-my-2w">
        {{ za.code }} {{ za.nom }}
        <DsfrAccordion
          v-if="za.communes?.length > 0"
          class="fr-accordion--no-shadow fr-mt-1w"
          :title="`Voir les ${za.communes.length} communes`"
          :expanded-id="expandedId"
          @expand="expandedId = $event"
        >
          <span v-for="(c, cIndex) of za.communes" :key="cIndex"> {{ c.code }} - {{ c.nom }}<br /> </span>
        </DsfrAccordion>
      </p>
    </template>
  </template>
</template>
