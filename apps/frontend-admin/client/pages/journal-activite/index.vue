<script setup lang="ts">
import type { AuditDetail, AuditRow } from '~/dto/audit.dto';
import {
  auditActionGroups,
  auditFiltersQuery,
  auditResourceLabel,
  auditResourceLabels,
  auditResultLabel,
  auditResultLabels,
  defaultAuditFilters,
  formatAuditDate,
} from '~/utils/audit';

definePageMeta({ layout: 'basic', middleware: 'role', roles: ['mte'] });
useHead({ title: `Journal d’activité - ${useRuntimeConfig().public.appName}` });

const api = useApi();
const filters = reactive(defaultAuditFilters());
const appliedFilters = ref({ ...filters });
const rows = ref<AuditRow[]>([]);
const loading = ref(false);
const errorMessage = ref('');
const currentCursor = ref<string | null>(null);
const previousCursors = ref<(string | null)[]>([]);
const nextCursor = ref<string | null>(null);
const detail = ref<AuditDetail | null>(null);
const detailOpened = ref(false);
const detailLoading = ref(false);
const detailError = ref('');
let listRequest = 0;
let detailRequest = 0;

const requestErrorMessage = (error: any) =>
  error?.statusCode === 403 || error?.status === 403
    ? 'Le journal est réservé aux administrateurs MTE. Votre accès n’est pas autorisé.'
    : 'Le journal est temporairement indisponible. Vous pouvez réessayer.';

async function loadPage(cursor: string | null = null, history: (string | null)[] = []) {
  const request = ++listRequest;
  loading.value = true;
  errorMessage.value = '';
  try {
    const { data, error } = await api.audit.list(appliedFilters.value, cursor);
    if (request !== listRequest) return;
    if (error.value) {
      rows.value = [];
      nextCursor.value = null;
      errorMessage.value = requestErrorMessage(error.value);
      return;
    }
    rows.value = data.value.items;
    nextCursor.value = data.value.nextCursor;
    currentCursor.value = cursor;
    previousCursors.value = history;
  } catch (error) {
    if (request === listRequest) {
      rows.value = [];
      errorMessage.value = error instanceof Error ? error.message : 'La recherche a échoué.';
    }
  } finally {
    if (request === listRequest) loading.value = false;
  }
}

async function search() {
  try {
    auditFiltersQuery(filters);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Les filtres sont invalides.';
    return;
  }
  appliedFilters.value = { ...filters };
  await loadPage();
}

function resetFilters() {
  Object.assign(filters, defaultAuditFilters());
  return search();
}

function previousPage() {
  const history = [...previousCursors.value];
  const cursor = history.pop() ?? null;
  return loadPage(cursor, history);
}

function nextPage() {
  if (!nextCursor.value) return;
  return loadPage(nextCursor.value, [...previousCursors.value, currentCursor.value]);
}

function closeDetail() {
  detailRequest++;
  detailOpened.value = false;
  detail.value = null;
  detailError.value = '';
  detailLoading.value = false;
}

async function openDetail(row: AuditRow) {
  const request = ++detailRequest;
  detail.value = null;
  detailOpened.value = true;
  detailLoading.value = true;
  detailError.value = '';
  try {
    const { data, error } = await api.audit.detail(row.id);
    if (request !== detailRequest) return;
    if (error.value) detailError.value = requestErrorMessage(error.value);
    else detail.value = data.value;
  } finally {
    if (request === detailRequest) detailLoading.value = false;
  }
}

async function moreResources() {
  if (!detail.value?.nextResourceCursor || detailLoading.value) return;
  const request = ++detailRequest;
  const previous = detail.value;
  detailLoading.value = true;
  detailError.value = '';
  try {
    const { data, error } = await api.audit.detail(previous.id, previous.nextResourceCursor);
    if (request !== detailRequest) return;
    if (error.value) detailError.value = requestErrorMessage(error.value);
    else detail.value = { ...data.value, resources: [...previous.resources, ...data.value.resources] };
  } finally {
    if (request === detailRequest) detailLoading.value = false;
  }
}

onMounted(() => loadPage());
onUnmounted(() => {
  listRequest++;
  detailRequest++;
});
</script>

<template>
  <div class="audit-journal">
    <h1>Journal d’activité</h1>
    <p>Retrouvez les actions et consultations des utilisateurs. Les traces sont conservées pendant deux ans.</p>
    <form class="audit-filters fr-mb-3w" aria-label="Filtrer le journal" @submit.prevent="search">
      <div class="fr-input-group">
        <label class="fr-label" for="audit-from">Du</label>
        <input id="audit-from" v-model="filters.from" class="fr-input" type="date" required />
      </div>
      <div class="fr-input-group">
        <label class="fr-label" for="audit-to">Au</label>
        <input id="audit-to" v-model="filters.to" class="fr-input" type="date" required />
      </div>
      <div class="fr-input-group">
        <label class="fr-label" for="audit-actor">Utilisateur</label>
        <input id="audit-actor" v-model="filters.actor" class="fr-input" type="text" maxlength="200" placeholder="Adresse e-mail" />
      </div>
      <div class="fr-select-group">
        <label class="fr-label" for="audit-action">Action</label>
        <select id="audit-action" v-model="filters.action" class="fr-select">
          <option value="">Toutes les actions</option>
          <optgroup v-for="group in auditActionGroups" :key="group.prefix" :label="group.label">
            <option v-for="(label, action) in group.actions" :key="action" :value="`${group.prefix}.${action}`">{{ label }}</option>
          </optgroup>
        </select>
      </div>
      <div class="fr-select-group">
        <label class="fr-label" for="audit-result">Résultat</label>
        <select id="audit-result" v-model="filters.result" class="fr-select">
          <option value="">Tous les résultats</option>
          <option
            v-for="result in ['succeeded', 'denied', 'failed', 'partial', 'accepted', 'started', 'unknown']"
            :key="result"
            :value="result"
          >
            {{ auditResultLabels[result] }}
          </option>
        </select>
      </div>
      <div class="fr-select-group">
        <label class="fr-label" for="audit-resource-type">Type de ressource</label>
        <select id="audit-resource-type" v-model="filters.resourceType" class="fr-select">
          <option value="">Tous les types</option>
          <option v-for="(label, type) in auditResourceLabels" :key="type" :value="type">{{ label }}</option>
        </select>
      </div>
      <div class="fr-input-group">
        <label class="fr-label" for="audit-resource-id">Identifiant de la ressource</label>
        <input id="audit-resource-id" v-model="filters.resourceId" class="fr-input" type="text" maxlength="200" />
      </div>
      <div class="fr-input-group">
        <label class="fr-label" for="audit-departement">Département</label>
        <input id="audit-departement" v-model="filters.departement" class="fr-input" type="text" maxlength="3" placeholder="Ex. 33" />
      </div>
      <div class="audit-filter-actions">
        <button type="submit" class="fr-btn" :disabled="loading">Rechercher</button>
        <button type="button" class="fr-btn fr-btn--secondary" :disabled="loading" @click="resetFilters">Réinitialiser</button>
      </div>
    </form>
    <DsfrAlert v-if="errorMessage" class="fr-mb-2w" type="error" :description="errorMessage" :small="true" />
    <button v-if="errorMessage" type="button" class="fr-btn fr-btn--secondary fr-mb-2w" :disabled="loading" @click="search">
      Réessayer
    </button>
    <p v-if="loading" role="status">Chargement du journal…</p>
    <p v-else-if="!errorMessage && !rows.length" role="status">Aucune action ne correspond à ces filtres.</p>
    <div
      v-if="rows.length && !errorMessage"
      class="fr-table audit-table"
      :aria-busy="loading"
      tabindex="0"
      role="region"
      aria-label="Tableau des activités, défilement horizontal possible"
    >
      <table>
        <caption>
          Actions des utilisateurs — heure de Paris
        </caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Utilisateur</th>
            <th scope="col">Action</th>
            <th scope="col">Ressource</th>
            <th scope="col">Territoire</th>
            <th scope="col">Résultat</th>
            <th scope="col">Détail</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id" data-cy="AuditRow">
            <td>
              <time :datetime="row.occurredAt">{{ formatAuditDate(row.occurredAt) }}</time>
            </td>
            <td>
              {{ row.actor?.email || 'Système'
              }}<span v-if="row.actor?.firstName || row.actor?.lastName" class="audit-subtitle"
                >{{ row.actor.firstName }} {{ row.actor.lastName }}</span
              >
            </td>
            <td>{{ row.actionLabel || row.action }}</td>
            <td>
              {{ row.resourceLabel || (row.resourceType ? auditResourceLabel(row.resourceType) : '—')
              }}<span v-if="row.resourceId" class="audit-subtitle">{{ row.resourceId }}</span>
            </td>
            <td>{{ row.territories?.join(', ') || '—' }}</td>
            <td><span v-if="row.simulation">Simulation — </span>{{ auditResultLabel(row.result) }}</td>
            <td>
              <button
                type="button"
                class="fr-btn fr-btn--secondary fr-btn--sm"
                :aria-label="`Détail de ${row.actionLabel || row.action} du ${formatAuditDate(row.occurredAt)}`"
                @click="openDetail(row)"
              >
                Détail
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <nav v-if="!errorMessage && rows.length" class="audit-pagination" aria-label="Pagination du journal">
      <button type="button" class="fr-btn fr-btn--secondary" :disabled="loading || !previousCursors.length" @click="previousPage">
        Précédent
      </button>
      <span aria-live="polite">Page {{ previousCursors.length + 1 }}</span>
      <button type="button" class="fr-btn fr-btn--secondary" :disabled="loading || !nextCursor" @click="nextPage">Suivant</button>
    </nav>
    <DsfrModal
      :opened="detailOpened"
      size="lg"
      title="Détail de l’activité"
      :actions="[{ label: 'Fermer', onclick: closeDetail }]"
      @close="closeDetail"
    >
      <p v-if="detailLoading" role="status">Chargement du détail…</p>
      <DsfrAlert v-if="detailError" type="error" :description="detailError" :small="true" />
      <AuditDetail v-if="detail" :detail="detail" @open-operation="openDetail" />
      <button
        v-if="detail?.nextResourceCursor"
        type="button"
        class="fr-btn fr-btn--secondary"
        :disabled="detailLoading"
        @click="moreResources"
      >
        Afficher davantage de changements
      </button>
    </DsfrModal>
  </div>
</template>

<style scoped>
.audit-filters {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1rem;
}
.audit-filters .fr-input-group,
.audit-filters .fr-select-group {
  margin-bottom: 0;
}
.audit-filter-actions {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
}
.audit-table {
  overflow-x: auto;
}
.audit-table table {
  min-width: 56rem;
}
.audit-table td {
  overflow-wrap: anywhere;
  vertical-align: top;
}
.audit-subtitle {
  display: block;
  font-size: 0.875rem;
}
.audit-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
@media (max-width: 62em) {
  .audit-filters {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 36em) {
  .audit-filters {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
