<script setup lang="ts">
import type { ArreteRestriction } from "~/dto/arrete_restriction.dto";
import { RestrictionNiveauGraviteFr } from "~/dto/restriction.dto";
import NiveauGraviteBadge from "~/components/mixins/NiveauGraviteBadge.vue";

const props = defineProps<{
  arreteRestriction: ArreteRestriction;
}>();

const restrictionNiveauGraviteFr = RestrictionNiveauGraviteFr;
const expandedId = ref();
const acFiltered = ref(props.arreteRestriction.arretesCadre.filter(ac => {
  return props.arreteRestriction.restrictions.some(r => r.arreteCadre?.id === ac.id);
}));

const getRestrictionsByZoneTypeAndAc = (type: string, acId: number | null) => {
  if(type === 'AEP') {
    return props.arreteRestriction.restrictions.filter((r) => r.isAep && r.arreteCadre?.id === acId);
  }
  return props.arreteRestriction.restrictions.filter((r) => r.zoneAlerte?.type === type && r.arreteCadre?.id === acId);
};

const zonesType = [
  { type: 'SUP', label: 'Eaux superficielles' },
  { type: 'SOU', label: 'Eaux souterraines' },
  { type: 'AEP', label: 'Eau potable' },
];
</script>

<template>
  <h2>Zones d'alerte</h2>
  <div v-for="ac of acFiltered">
    <b>{{ ac.numero }}</b>
    <div class="fr-mt-2w fr-mb-4w"  v-for="zoneType of zonesType">
      <template v-if="getRestrictionsByZoneTypeAndAc(zoneType.type, ac.id).length > 0">
        <p><b>{{ zoneType.label }}</b></p>
        <p v-for="r of getRestrictionsByZoneTypeAndAc(zoneType.type, ac.id)" class="fr-ml-2w fr-my-2w">
          <div class="fr-grid-row fr-grid-row--middle fr-mb-2w">
            <template v-if="r.zoneAlerte">
              {{ r.zoneAlerte?.code }} {{ r.zoneAlerte?.nom }}
            </template>
            <template v-else>
              {{ r.nomGroupementAep }}
            </template>
            <NiveauGraviteBadge v-if="r.niveauGravite"
                                class="fr-ml-2w"
                                :niveauGravite="r.niveauGravite" />
            <DsfrBadge v-if="r.zoneAlerte?.ressourceInfluencee"
                       label="Ressource influencée"
                       class="fr-ml-2w fr-badge--no-icon"/>
          </div>
          <DsfrAccordion :title="'Voir les ' + r.usages.length + ' usages'"
                         v-if="r.usages.length > 0"
                         class="fr-accordion--no-shadow"
                         :expanded-id="expandedId"
                         @expand="expandedId = $event">
            <div v-for="usage in r.usages">
              <b>{{ usage.nom }}</b>
              <div class="full-width">
                <template v-if="r.niveauGravite === 'vigilance'">
                  {{ usage.descriptionVigilance }}
                </template>
                <template v-else-if="r.niveauGravite === 'alerte'">
                  {{ usage.descriptionAlerte }}
                </template>
                <template v-else-if="r.niveauGravite === 'alerte_renforcee'">
                  {{ usage.descriptionAlerteRenforcee }}
                </template>
                <template v-else-if="r.niveauGravite === 'crise'">
                  {{ usage.descriptionCrise }}
                </template>
              </div>
              <div class="divider fr-mb-2w" />
            </div>
          </DsfrAccordion>
          <div class="divider" />
        </p>
      </template>
    </div>
  </div>
</template>