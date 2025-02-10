<script setup lang="ts">
import type { ArreteRestriction } from '~/dto/arrete_restriction.dto';
import { useRefDataStore } from '~/stores/refData';
import type { Ref } from 'vue';
import { helpers } from '@vuelidate/validators/dist';
import useVuelidate from '@vuelidate/core';
import type { Departement } from '~/dto/departement.dto';
import type { ZoneAlerte } from '~/dto/zone_alerte.dto';
import type { ArreteCadre } from '~/dto/arrete_cadre.dto';

const props = defineProps<{
  arreteRestriction: ArreteRestriction;
  selected: boolean;
}>();

const refDataStore = useRefDataStore();
const utils = useUtils();
const zonesSelected: Ref<{ zoneId: number; acId: number }[]> = ref(
  props.arreteRestriction.restrictions
    .filter((r) => !r.isAep)
    .map((r) => {
      return { zoneId: r.zoneAlerte.id, acId: r.arreteCadre.id };
    }),
);
const acFiltered: Ref<any[]> = ref([]);

const rules = computed(() => {
  return {
    restrictions: {
      required: helpers.withMessage("L'arrêté doit être lié à au moins une zone d'alerte.", () => {
        return props.arreteRestriction.restrictions.filter((r) => !r.isAep).length > 0;
      }),
    },
  };
});

const v$ = useVuelidate(rules, props.arreteRestriction);

const zonesOptionsCheckBox = (ac: ArreteCadre, type: string) => {
  const arsAssociated = ac.arretesRestriction.filter((ar) => ar.id !== props.arreteRestriction.id);
  //@ts-ignore
  return ac.zonesAlerteFiltered
    ?.filter((z) => z.type === type)
    .map((z) => {
      return {
        id: z.id,
        name: z.id,
        label: `${z.code} ${z.nom ? z.nom : ''}`,
        isArAssociated: arsAssociated.some((ar) => ar.restrictions?.some((r) => r.zoneAlerte?.id === z.id)),
        ressourceInfluencee: z.ressourceInfluencee,
      };
    });
};

const selectAll = (ac: any) => {
  if (ac.nbZonesSelected >= ac.zonesAlerteFiltered?.length) {
    zonesSelected.value = zonesSelected.value.filter((z) => !(ac.zonesAlerteFiltered?.some((za: any) => za.id === z.zoneId) && z.acId === ac.id));
  } else {
    zonesSelected.value = useUtils().mergeArrays(
      zonesSelected.value,
      ac.zonesAlerteFiltered?.map((za: ZoneAlerte) => {
        return {
          zoneId: za.id,
          acId: ac.id,
        }
      }),
    );
  }
};

const computeZonesSelected = () => {
  acFiltered.value.forEach((ac) => {
    ac.nbZonesSelected = zonesSelected.value.filter(
      (z) => ac.zonesAlerteFiltered?.some((za: ZoneAlerte) => za.id === z.zoneId) && ac.id === z.acId,
    ).length;
  });
};

const onChange = ({ zoneId, checked, acId }: { zoneId: number; checked: boolean; acId: number }) => {
  zonesSelected.value = checked
    ? [...zonesSelected.value, { zoneId: zoneId, acId: acId }]
    : zonesSelected.value.filter((z) => !(z.zoneId === zoneId && z.acId === acId));
};

const loadZones = () => {
  if (!props.arreteRestriction) {
    return;
  }
  // On récupère le tableau de départements des arrêtés cadres
  const departement = props.arreteRestriction.departement;
  acFiltered.value = props.arreteRestriction.arretesCadre.map((ac) => {
    return {
      ...ac,
      zonesAlerteFiltered: ac.zonesAlerte.filter((z) => z.departement.id === departement?.id),
    };
  });

  zonesSelected.value = zonesSelected.value.filter((z) =>
    acFiltered.value.some((ac) => ac.id === z.acId && ac.zonesAlerteFiltered.some((za) => za.id === z.zoneId)),
  );
  computeZonesSelected();
}

watch(zonesSelected, () => {
  props.arreteRestriction.restrictions = props.arreteRestriction.restrictions.filter(
    (r) => r.isAep || zonesSelected.value.some((zs) => zs.zoneId === r.zoneAlerte.id && zs.acId === r.arreteCadre.id)
  );
  const allZones = acFiltered.value
    .map((ac) => {
      return ac.zonesAlerteFiltered?.map((za) => {
        return { zoneAlerte: za, acId: ac.id };
      });
    })
    .flat();
  const allZonesSelected = allZones.filter(
    (z) => zonesSelected.value.some(zs => zs.zoneId === z.zoneAlerte.id && zs.acId === z.acId )
  );
  const newZones = allZonesSelected.filter((z) => 
    !props.arreteRestriction.restrictions.some((r) => r.zoneAlerte?.id === z.zoneAlerte.id && r.arreteCadre?.id === z.acId)
  );
  newZones.forEach((z) => {
    let ac = props.arreteRestriction.arretesCadre
      .find((ac) => ac.id === z.acId);
    props.arreteRestriction.restrictions.push({
      id: null,
      zoneAlerte: z.zoneAlerte,
      arreteCadre: ac,
      niveauGravite: null,
      usages: [],
      isAep: false,
      communes: null,
      nomGroupementAep: null,
      communesText: undefined,
    });
  });
  props.arreteRestriction.restrictions = props.arreteRestriction.restrictions.sort((a, b) => {
    if (a.zoneAlerte?.code < b.zoneAlerte?.code) {
      return -1;
    }
    if (a.zoneAlerte?.code > b.zoneAlerte?.code) {
      return 1;
    }
    return 0;
  });
  computeZonesSelected();
});

watch(
  () => props.arreteRestriction.arretesCadre,
  () => {
    loadZones();
  },
  { immediate: true },
);

watch(
  () => props.arreteRestriction.departement,
  () => {
    loadZones();
  },
  { immediate: true },
);

computeZonesSelected();

defineExpose({
  v$,
});
</script>

<template>
  <form @submit.prevent="">
    <div class="fr-grid-row">
      <div class="fr-col-12 fr-col-lg-6">
        <DsfrInputGroup :error-message="utils.showInputError(v$, 'restrictions')">
          <div v-for="ac of acFiltered">
            <div class="zone-alerte__title">
              <h6>Zones d'alerte de l'arrêté {{ ac.numero }} ({{ ac.nbZonesSelected }}/{{ ac.zonesAlerteFiltered?.length }})</h6>
              <div>
                Tout sélectionner
                <DsfrCheckbox
                  :onUpdate:modelValue="() => selectAll(ac)"
                  :disabled="ac.zonesAlerteFiltered?.length < 1 || zonesSelected.some((z) => ac.zonesAlerteFiltered?.some(za => za.id === z.zoneId) && z.acId !== ac.id)"
                  :checked="ac.nbZonesSelected === ac.zonesAlerteFiltered?.length"
                />
              </div>
            </div>
            <div class="zone-alerte__body" v-if="zonesOptionsCheckBox(ac, 'SUP').length > 0">
              <p><b>Eaux superficielles</b></p>
              <div class="form-group fr-fieldset fr-mt-2w">
                <DsfrCheckbox
                  v-for="option in zonesOptionsCheckBox(ac, 'SUP')"
                  :id="ac.id + ' ' + option.id"
                  :key="option.id || option.name"
                  :name="option.name"
                  :model-value="zonesSelected.some((z) => z.zoneId === option.id && z.acId === ac.id)"
                  :small="false"
                  :disabled="zonesSelected.some((z) => z.zoneId === option.id && z.acId !== ac.id)"
                  @update:model-value="onChange({ zoneId: option.id, checked: $event, acId: ac.id })"
                >
                  <template #label>
                    {{ option.label }}
                    <DsfrTooltip v-if="option.ressourceInfluencee"
                                 on-hover
                                 content="Ressource influencée">
                      <DsfrBadge label="RI"
                                 @click="$event.preventDefault();"
                                 class="fr-ml-2w fr-badge--no-icon"/>
                    </DsfrTooltip>
                    <div class="checkbox-label-info" v-if="option.isArAssociated">
                      <VIcon name="ri-information-fill" />
                      Cette zone est utilisée dans un autre arrêté de restriction actif
                    </div>
                  </template>
                </DsfrCheckbox>
              </div>
            </div>
            <div class="zone-alerte__body" v-if="zonesOptionsCheckBox(ac, 'SOU').length > 0">
              <p><b>Eaux souterraines</b></p>
              <div class="form-group fr-fieldset fr-mt-2w">
                <DsfrCheckbox
                  v-for="option in zonesOptionsCheckBox(ac, 'SOU')"
                  :id="ac.id + ' ' + option.id"
                  :key="option.id || option.name"
                  :name="option.name"
                  :model-value="zonesSelected.some((z) => z.zoneId === option.id && z.acId === ac.id)"
                  :small="false"
                  :disabled="zonesSelected.some((z) => z.zoneId === option.id && z.acId !== ac.id)"
                  @update:model-value="onChange({ zoneId: option.id, checked: $event, acId: ac.id })"
                >
                  <template #label>
                    {{ option.label }}
                    <div class="checkbox-label-info" v-if="option.isArAssociated">
                      <VIcon name="ri-information-fill" />
                      Cette zone est utilisée dans un autre arrêté de restriction en vigueur
                    </div>
                  </template>
                </DsfrCheckbox>
              </div>
            </div>
          </div>
        </DsfrInputGroup>
      </div>
      <div class="fr-col-12 fr-col-lg-6">
        <!--        <ArreteRestrictionFormZonesMap v-if="selected" :arreteRestriction="arreteRestriction" />-->
      </div>
    </div>
  </form>
</template>

<style lang="scss">
.zone-alerte {
  &__title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;

    h6 {
      margin: 0;
    }

    div {
      display: flex;
      align-items: center;

      & > * {
        flex: none;
      }

      .fr-fieldset__element {
        margin-bottom: 1.5rem;
      }
    }
  }

  &__body {
    & > p {
      margin: 0;
    }

    .fr-checkbox-group {
      input[type='checkbox'] + label {
        margin-left: 0;
        padding-right: 3rem;

        &::before {
          left: auto;
          right: 0.5rem;
        }

        &::after {
          content: '';
          display: block;
          position: absolute;
          width: 100%;
          border-top: 1px solid var(--grey-925-125);
          top: -0.5rem;
        }

        .checkbox-label-info {
          display: block;
          color: var(--info-425-625);
          width: 100%;
        }
      }
    }
  }

  &__a-completer {
    justify-content: space-between;

    & > div:not(:first-child) {
      color: var(--blue-france-sun-113-625);
    }
  }
}

.fr-link {
  background: none;
}
</style>
