<script setup lang="ts">
import type {ArreteRestriction} from "~/dto/arrete_restriction.dto";
import NiveauGraviteBadge from "~/components/mixins/NiveauGraviteBadge.vue";

const props = defineProps<{
  arreteRestriction: ArreteRestriction;
}>();

const expandedId = ref();
const acFiltered = ref(props.arreteRestriction.arretesCadre.filter(ac => {
  return props.arreteRestriction.restrictions.some(r => r.arreteCadre?.id === ac.id);
}));

const getRestrictionsByZoneTypeAndAc = (type: string, acId: number | null, ressourceInfluencee?: boolean) => {
  return props.arreteRestriction.restrictions.filter(r => {
    const matchType = type === "AEP" ? r.isAep : r.zoneAlerte?.type === type;
    const matchArrete = r.arreteCadre?.id === acId;
    const matchRessource = ressourceInfluencee === undefined || r.zoneAlerte?.ressourceInfluencee === ressourceInfluencee;
    return matchType && matchArrete && matchRessource;
  });
};

const zonesType = [
  {type: 'SUP', label: 'Eaux superficielles'},
  {type: 'SOU', label: 'Eaux souterraines'},
  {type: 'AEP', label: 'Eau potable'},
];
</script>

<template>
  <h2>Zones d'alerte</h2>
  <div v-for="ac of acFiltered">
    <b>{{ ac.numero }}</b>

    <div class="fr-mt-2w fr-mb-4w" v-for="zoneType in zonesType" :key="zoneType.type">
      <template v-if="getRestrictionsByZoneTypeAndAc(zoneType.type, ac.id).length">
        <p><b>{{ zoneType.label }}</b></p>
        <template v-for="ressourceInfluencee in [false, true]"
                  :key="ressourceInfluencee">
          <p v-if="ressourceInfluencee" class="fr-ml-2w">
            <u>Ressources influencées</u>
          </p>
          <div v-for="r in getRestrictionsByZoneTypeAndAc(zoneType.type, ac.id, ressourceInfluencee)"
               :key="r.id"
               class="fr-ml-2w fr-my-2w">
            <div class="fr-grid-row fr-grid-row--middle fr-mb-2w">
              <span>{{ r.zoneAlerte?.code }} {{ r.zoneAlerte?.nom || r.nomGroupementAep }}</span>
              <NiveauGraviteBadge v-if="r.niveauGravite"
                                  class="fr-ml-2w"
                                  :niveauGravite="r.niveauGravite"/>
              <DsfrBadge v-if="r.zoneAlerte?.ressourceInfluencee"
                         label="Ressource influencée"
                         class="fr-ml-2w fr-badge--no-icon"/>
            </div>
            <DsfrAccordion v-if="r.usages.length"
                           :title="'Voir les ' + r.usages.length + ' usages'"
                           class="fr-accordion--no-shadow"
                           :expanded-id="expandedId"
                           @expand="expandedId = $event">
              <div v-for="usage in r.usages"
                   :key="usage.id">
                <b>{{ usage.nom }}</b>
                <div class="full-width">{{
                    usage[`description${r.niveauGravite.charAt(0).toUpperCase() + r.niveauGravite.slice(1)}`]
                  }}
                </div>
                <div class="divider fr-mb-2w"/>
              </div>
            </DsfrAccordion>
            <div class="divider"/>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>