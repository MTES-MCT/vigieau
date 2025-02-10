<script setup lang="ts">
import type { Ref } from 'vue';
import { useRefDataStore } from '~/stores/refData';
import { Usage } from '~/dto/usage.dto';
import deburr from 'lodash.deburr';
import type { ArreteRestriction } from '~/dto/arrete_restriction.dto';
import { useAlertStore } from '~/stores/alert';

const props = defineProps<{
  arreteRestriction: ArreteRestriction;
}>();
const usageToEdit: Ref<Usage | undefined> = ref(new Usage());
const canEditName: Ref<boolean> = ref(true);
const componentKey = ref(0);

const query: Ref<string> = ref('');
const usagesFiltered: Ref<Usage[]> = ref([]);
const refDataStore = useRefDataStore();
const alertStore = useAlertStore();
const utils = useUtils();

const createEditUsageFormRef = ref();
const modalOpened = ref(false);
const modalActions = ref([
  {
    label: 'Enregistrer',
    onclick: () => {
      createEditUsageFormRef.value?.submitForm();
    },
  },
  {
    label: 'Annuler',
    secondary: true,
    onclick: () => {
      utils.closeModal(modalOpened);
    },
  },
]);
const usageNameEdited: Ref<string | null> = ref(null);

const arreteRestrictionUsages = computed(() => {
  return props.arreteRestriction.restrictions.map((r) => r.usages).flat().filter((value, index, self) =>
      index === self.findIndex((t) => (
        t.nom === value.nom
      )),
  );
});

const filterUsages = () => {
  let tmp: any[] = [];
  tmp = query.value ? refDataStore.usages.filter((u) => {
    const nom = deburr(u.nom)
      .replace(/[\-\_]/g, '');
    const queryWords = deburr(query.value)
      .replace(/[\-\_]/g, '')
      .split(' ')
      .map(s => s.replace(/^/, '(').replace(/$/, ')'))
      .join('*');
    const regex = new RegExp(`${queryWords}`, 'gi');
    return nom.match(regex);
  }) : refDataStore.usages;
  tmp = tmp.filter((u) => {
    return arreteRestrictionUsages.value.findIndex((uac) => uac.nom === u.nom) < 0;
  });
  usagesFiltered.value = tmp;
};

const selectUsage = (usage: Usage | string) => {
  if (typeof usage === 'string') {
    return;
  }
  query.value = '';
  if (!usage.id) {
    return;
  }
  componentKey.value += 1;
  let usageRestriction = arreteRestrictionUsages.value.find((aru) => aru.nom === (<Usage>usage).nom);
  if (!usageRestriction) {
    usageRestriction = new Usage(<Usage>usage);
  }
  askCreateEditUsage(null, usageRestriction);
};

const askCreateEditUsage = (index: number | null = null, usage?: Usage) => {
  const u = index !== null ? JSON.parse(JSON.stringify(arreteRestrictionUsages.value[index])) : new Usage(usage);
  u.id = null;
  usageToEdit.value = u;
  canEditName.value = !u.nom;
  usageNameEdited.value = index !== null ? u.nom : null;
  setTimeout(() => {
    modalOpened.value = true;
  });
};

const createEditUsage = async (usage: Usage) => {
  if (!usageNameEdited.value) {
    props.arreteRestriction.restrictions.forEach(r => {
      r.usages.push(usage);
    });
    alertStore.addAlert({
      description: `L'usage "${usage.nom}" a bien été ajouté.`,
      type: 'success',
    });
  } else {
    props.arreteRestriction.restrictions.forEach(r => {
      const index = r.usages.findIndex(u => u.nom === usageNameEdited.value);
      if(index >= 0) {
        r.usages[index] = usage;
      }
    });
    alertStore.addAlert({
      description: `L'usage "${usage.nom}" a bien été modifié.`,
      type: 'success',
    });
  }
  componentKey.value += 1;
  usageNameEdited.value = null;
  utils.closeModal(modalOpened);
};

watch(
  query,
  useUtils().debounce(async () => {
    filterUsages();
  }, 300),
  { immediate: true },
);

const arreteCadreUsageListRef = ref(null);

defineExpose({
  selectUsage,
  arreteCadreUsageListRef,
});
</script>

<template>
  <form @submit.prevent="">
    <div class="fr-grid-row fr-grid-row--gutters">
      <div class="fr-col-12 fr-col-lg-6">
        <ArreteCadreUsageList
          ref="arreteCadreUsageListRef"
          :usages="arreteRestrictionUsages"
          :hideRemove="true"
          @usage-selected="askCreateEditUsage($event)"
          :key="componentKey"
        />
      </div>
      <div class="fr-col-12 fr-col-lg-6">
        <div class="usage-card">
          <h6>Il manque un usage dans votre liste ?</h6>
          <p>
            Retrouvez les usages utilisés dans un arrêté précédent&nbsp;:
          </p>
          <DsfrInputGroup>
            <MixinsAutoComplete
              class="show-label"
              data-cy="ArreteCadreFormUsagesAutocomplete"
              placeholder="Saisir le nom d'un usage"
              buttonText="Chercher"
              display-key="nom"
              v-model="query"
              :options="usagesFiltered"
              @update:modelValue="selectUsage($event)"
            />
          </DsfrInputGroup>
          <div class="fr-grid-row fr-grid-row--middle fr-mb-2w">
            <div style="flex: 1;" class="divider" />
            <span class="fr-mx-4w">ou</span>
            <div style="flex: 1;" class="divider" />
          </div>
          <div class="fr-grid-row fr-grid-row--middle fr-grid-row--space-between">
            <span>L'usage n'existe pas</span>
            <DsfrButton label="Créer un nouvel usage"
                        @click="askCreateEditUsage()" />
          </div>
        </div>
      </div>
    </div>
  </form>
  <Teleport to="body">
    <DsfrModal
      :opened="modalOpened"
      title="Création / édition d'un usage"
      :actions="modalActions"
      @close="modalOpened = utils.closeModal(modalOpened);">
      <ArreteCadreFormCreateEditUsage
        v-if="modalOpened"
        ref="createEditUsageFormRef"
        @createEdit="createEditUsage($event)"
        :usage="usageToEdit"
        :disableUsageName="!canEditName"
        :other-usages="arreteRestrictionUsages"
      />
    </DsfrModal>
  </Teleport>
</template>

<style lang="scss">
.usage-form-wrapper {
  border: 1px solid var(--grey-925-125);
}

.select-option-usage {
  color: var(--blue-france-sun-113-625);
}

.list-item:hover {
  .select-option-usage {
    color: white;
  }
}

.usage-card {
  border: 1px solid var(--border-active-blue-france);
  padding: 1rem;
}
</style>
