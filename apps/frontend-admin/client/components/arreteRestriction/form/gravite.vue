<script setup lang="ts">
import type { ArreteRestriction } from '~/dto/arrete_restriction.dto';
import { helpers, required } from '@vuelidate/validators';
import useVuelidate from '@vuelidate/core';
import type { Restriction } from '~/dto/restriction.dto';
import type { ArreteCadre } from '~/dto/arrete_cadre.dto';
import type { Ref } from 'vue';

const props = defineProps<{
  arreteRestriction: ArreteRestriction;
  communes: any[];
  selected: boolean;
}>();

const emit = defineEmits<{
  editUsages: any;
}>();

const rules = computed(() => {
  return {
    restrictions: {
      required: helpers.withMessage('L\'arrêté doit être lié à au moins une zone d\'alerte', required),
    },
  };
});

const v$ = useVuelidate(rules, props.arreteRestriction);
const api = useApi();
const departementParametres: Ref<any> = ref(null);

const getRestrictionsByZoneType = (type: string) => {
  if (type === 'AEP') {
    return props.arreteRestriction.restrictions.filter((r) => r.isAep);
  }
  return props.arreteRestriction.restrictions.filter((r) => r.zoneAlerte?.type === type);
};

const getRestrictionsByZoneTypeAndAc = (type: string, acId: number | null) => {
  if (type === 'AEP') {
    return props.arreteRestriction.restrictions.filter((r) => r.isAep && r.arreteCadre?.id === acId);
  }
  return props.arreteRestriction.restrictions.filter((r) => r.zoneAlerte?.type === type && r.arreteCadre?.id === acId);
};

const getArreteCadreByRestriction = (restriction: Restriction) => {
  return props.arreteRestriction.arretesCadre.find((ac) => ac.id === restriction.arreteCadre.id);
};

const acFiltered: Ref<ArreteCadre[]> = ref([]);
const zonesType = [
  { type: 'SUP', label: 'Eaux superficielles' },
  { type: 'SOU', label: 'Eaux souterraines' },
  { type: 'AEP', label: 'Eau potable' },
];
const isSameNiveauGravite = ref(props.arreteRestriction.restrictions?.every((r, i, arr) => r.niveauGravite === arr[0].niveauGravite));
const sameNiveauGravite = ref(isSameNiveauGravite.value ? props.arreteRestriction.restrictions[0]?.niveauGravite : null);
const niveauGraviteOptions = [
  {
    text: 'Vigilance',
    value: 'vigilance',
  },
  {
    text: 'Alerte',
    value: 'alerte',
  },
  {
    text: 'Alerte renforcée',
    value: 'alerte_renforcee',
  },
  {
    text: 'Crise',
    value: 'crise',
  },
];

const applyToAllRestrictions = (restriction: Restriction, $event: any) => {
  const restrictions: Restriction[] = getRestrictionsByZoneType(restriction.isAep ? 'AEP' : restriction.zoneAlerte.type);
  restrictions.forEach(r => {
    r.usages = r.usages.filter(u => u.nom !== $event);
  });
};

defineExpose({
  v$,
});

watch(sameNiveauGravite, () => {
  if (!isSameNiveauGravite.value || !sameNiveauGravite.value) {
    return;
  }
  props.arreteRestriction.restrictions = props.arreteRestriction.restrictions.map((r) => {
    r.niveauGravite = sameNiveauGravite.value;
    return r;
  });
});

watch(
  () => props.arreteRestriction.restrictions.map((r) => r.niveauGravite),
  () => {
    isSameNiveauGravite.value = props.arreteRestriction.restrictions?.every((r, i, arr) => r.niveauGravite === arr[0].niveauGravite);
    if (!isSameNiveauGravite.value) {
      sameNiveauGravite.value = null;
    }
  },
);

watch(
  () => props.arreteRestriction.restrictions,
  () => {
    acFiltered.value = props.arreteRestriction.arretesCadre.filter(ac => {
      return props.arreteRestriction.restrictions.some(r => r.arreteCadre?.id === ac.id);
    });
  },
  { immediate: true },
);

watch(() => props.arreteRestriction.departement, async () => {
  if (props.arreteRestriction.departement) {
    const { data, error } = await api.parametres.get(props.arreteRestriction.departement.code);
    if (data.value) {
      departementParametres.value = data.value;
    }
  }
}, { immediate: true });
</script>

<template>
  <form @submit.prevent="">
    <div class="fr-grid-row fr-grid-row--gutters">
      <div class="fr-col-12 fr-col-lg-6">
        <div v-if="arreteRestriction.restrictions.length > 1"
             class="fr-grid-row fr-p-2w fr-mb-2w fr-grid-row--bottom fr-notice fr-notice--info">
          <div class="fr-col-10">
            <h6>Niveau de gravité commun aux zones d'alerte</h6>
            <p>Appliquer le même niveau de gravité pour toutes les zones d’alerte</p>
          </div>
          <div class="fr-col-2">
            <DsfrToggleSwitch v-model="isSameNiveauGravite" :labelLeft="true" />
          </div>
          <div class="fr-col-12 fr-mt-2w fr-grid-row" v-if="isSameNiveauGravite">
            <DsfrSelect
              id="role"
              v-model="sameNiveauGravite"
              :options="niveauGraviteOptions"
              label="Choisir un niveau de gravité unique"
              required
              type="text"
              name="niveauGravite"
            />
          </div>
        </div>
        <h6>Zones d'alerte</h6>
        <div v-for="ac of acFiltered">
          <b>{{ ac.numero }}</b>
          <div class="fr-mt-2w fr-mb-4w" v-for="zoneType of zonesType">
            <template v-if="getRestrictionsByZoneTypeAndAc(zoneType.type, ac.id).length > 0">
              <p>
                <b>{{ zoneType.label }}</b>
              </p>
              <div class="divider" />
              <div v-for="r in getRestrictionsByZoneTypeAndAc(zoneType.type, ac.id)" class="divider">
                <ArreteRestrictionFormRestriction
                  v-if="departementParametres"
                  :restriction="r"
                  :type="zoneType.type"
                  :arreteCadre="getArreteCadreByRestriction(r)"
                  :arreteRestriction="arreteRestriction"
                  :multipleZones="getRestrictionsByZoneTypeAndAc(zoneType.type, ac.id).length > 1"
                  @applyToAllRestrictions="applyToAllRestrictions(r, $event)"
                  :departementParametres="departementParametres"
                />
              </div>
            </template>
          </div>
        </div>
      </div>
      <div class="fr-col-12 fr-col-lg-6">
        <div class="fr-card fr-mb-2w fr-p-2w">
          <h3 class="fr-h6">
            Vous souhaitez ajouter ou modifier un usage&nbsp;?
          </h3>
          
          <div class="fr-grid-row fr-grid-row--right">
            <DsfrButton
              label="Modifier les usages"
              icon="ri-edit-2-fill"
              :secondary="true"
              @click="emit('editUsages')"
            />
          </div>
        </div>

        <ArreteRestrictionCarteRecapitulatif v-if="selected" :arreteRestriction="arreteRestriction" />
      </div>
    </div>
  </form>
</template>

<style lang="scss">
.fr-grid-row .fr-card {
  height: auto;
}
</style>
