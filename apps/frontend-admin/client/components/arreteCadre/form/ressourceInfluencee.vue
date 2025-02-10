<script setup lang="ts">
import type { ArreteCadre } from '~/dto/arrete_cadre.dto';
import type { Ref } from 'vue';
import type { Departement } from '~/dto/departement.dto';
import type { ZoneAlerte } from '~/dto/zone_alerte.dto';
import { useRefDataStore } from '~/stores/refData';
import type { Commune } from '~/dto/commune.dto';

const props = defineProps<{
  arreteCadre: ArreteCadre;
}>();

const refDataStore = useRefDataStore();
const utils = useUtils();
const api = useApi();

const departementsFiletered: Ref<any[]> = ref([]);
const zonesInfluenceesSelected: Ref<ZoneAlerte[]> = ref(props.arreteCadre.zonesAlerte.filter(z => z.ressourceInfluencee));
const communes: Ref<Commune[]> = ref([]);
const expandedId = ref();
const modalCommunesOpened = ref(false);
const groupementCommunesFormRef = ref(null);
const loading = ref(false);
const zoneToEdit = ref();
const accordionKey = ref(0);
const modalActions = ref([
  {
    label: 'Enregistrer',
    onclick: () => {
      groupementCommunesFormRef.value?.submitForm();
    },
  },
  {
    label: 'Annuler',
    secondary: true,
    onclick: () => {
      utils.closeModal(modalCommunesOpened);
    },
  },
]);

const computeDepSelected = () => {
  departementsFiletered.value.forEach((d) => {
    d.nbZonesInfluenceesSelected = zonesInfluenceesSelected.value.filter((z) => d.zonesAlerte.map((za: ZoneAlerte) => za.id).includes(z.id)).length;
  });
};

const zonesOptions = (dep: Departement) => {
  return zonesInfluenceesSelected.value.filter(z => dep.zonesAlerte.some(dz => dz.id === z.id));
};

const createEditGroupementCommunes = (zone: ZoneAlerte) => {
  zoneToEdit.value = structuredClone(toRaw(zone));
  modalCommunesOpened.value = true;
};

const createEditGroupement = async (zone: ZoneAlerte) => {
  const z = props.arreteCadre.zonesAlerte.find(z => z.id === zone.id);
  const zBis = zonesInfluenceesSelected.value.find(z => z.id === zone.id);
  if (z && zBis) {
    z.communes = JSON.parse(JSON.stringify(zone.communes));
    zBis.communes = JSON.parse(JSON.stringify(zone.communes));
  }
  sortCommunes();
  zoneToEdit.value = null;
  accordionKey.value++;
  utils.closeModal(modalCommunesOpened);
};

const sortCommunes = () => {
  props.arreteCadre.zonesAlerte
    .filter(z => z.communes)
    .forEach(z => {
      z.communes = z.communes?.sort((a, b) => {
        if (a.code < b.code) {
          return -1;
        }
        if (a.code > b.code) {
          return 1;
        }
        return 0;
      });
    });
};

watch(
  () => props.arreteCadre.departements,
  async () => {
    departementsFiletered.value = refDataStore.departements.filter((d) => props.arreteCadre.departements.some((ad) => ad.id === d.id));
    zonesInfluenceesSelected.value = zonesInfluenceesSelected.value.filter((z) =>
      departementsFiletered.value
        .map((d: Departement) => d.zonesAlerte.map((za: ZoneAlerte) => za.id))
        .flat()
        .includes(z.id),
    );
    computeDepSelected();

    const query = `depCode=${props.arreteCadre.departements?.map(d => d.code).join(',')}`;
    loading.value = true;
    const { data, error } = await api.commune.list(query);
    if (data.value) {
      communes.value = data.value;
    }
    loading.value = false;
  },
  { immediate: true },
);

watch(
  () => props.arreteCadre.zonesAlerte,
  async () => {
    zonesInfluenceesSelected.value = props.arreteCadre.zonesAlerte.filter(z => z.ressourceInfluencee);
    computeDepSelected();
  },
);
</script>

<template>
  <form @submit.prevent="">
    <div class="zone-alerte-influencee fr-grid-row fr-grid-row--gutters">
      <div class="fr-col-12 fr-col-lg-6">
        <p>
          Sélectionner les communes où ces ressources seront proposées.
        </p>
        <template v-for="(d, index) in departementsFiletered">
          <div class="divider fr-mb-2w"></div>
          <h6>Ressources influencées - {{ d.nom }} ({{ d.nbZonesInfluenceesSelected }})</h6>
          <div class="fr-grid-row fr-grid-row--space-between full-width">
            <div class="zone-item" v-for="option in zonesOptions(d)">
              <div class="fr-grid-row fr-grid-row--space-between fr-grid-row--middle">
                <div>{{ option.code }} {{ option.nom }}</div>
                <DsfrButton
                  :label="option.communes?.length > 0 ? 'Modifier un groupement de communes' : 'Ajouter un groupement de communes'"
                  secondary
                  @click="createEditGroupementCommunes(option)"
                  :key="option.id + '-' + accordionKey"
                />
              </div>
              <DsfrAccordion v-if="option.communes?.length > 0"
                             class="full-width fr-accordion--no-shadow fr-mt-1w"
                             :title="'Voir les ' + option.communes.length + ' communes'"
                             :expanded-id="expandedId"
                             @expand="expandedId = $event"
                             :key="option.id + '-' + accordionKey"
              >
                <span v-for="c of option.communes"> {{ c.code }} - {{ c.nom }}<br /> </span>
              </DsfrAccordion>
            </div>
          </div>
          <div class="divider fr-mb-2w"></div>
        </template>
      </div>
    </div>
  </form>


  <DsfrModal :opened="modalCommunesOpened"
             :title="zoneToEdit?.code + ' ' + zoneToEdit?.nom"
             :actions="modalActions"
             size="xl"
             @close="modalCommunesOpened = utils.closeModal(modalCommunesOpened);">
    <ArreteCadreFormGroupementCommunes :zoneAlerte="zoneToEdit"
                                       ref="groupementCommunesFormRef"
                                       :communes="communes"
                                       @createEdit="createEditGroupement($event)" />
  </DsfrModal>
</template>

<style lang="scss" scoped>
.zone-item {
  border-top: 1px solid var(--grey-925-125);
  width: 100%;
  padding: 0.5rem 0;
}
</style>
