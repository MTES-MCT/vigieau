<script setup lang="ts">
import {
  getTablePaginationState,
  paginateTableRows,
} from '../utils/table-pagination';
import type { HTMLAttributes, TdHTMLAttributes } from 'vue';

type TableCell = string | number | boolean | Record<string, any> | null;
type TableRow =
  | TableCell[]
  | {
      rowAttrs?: HTMLAttributes;
      rowData?: TableCell[];
    };

const props = withDefaults(
  defineProps<{
    fixedLayout?: boolean;
    headers: Array<string | Record<string, any>>;
    paginationContext?: string;
    resultsPerPage?: number;
    rowHeaderColumn?: number | null;
    rows: TableRow[];
    statusPrefix?: string;
    tableClass?: string | string[] | Record<string, boolean>;
    tableId: string;
    title: string;
  }>(),
  {
    fixedLayout: false,
    paginationContext: '',
    resultsPerPage: 10,
    rowHeaderColumn: null,
    statusPrefix: '',
    tableClass: '',
  },
);

const resultsPerPageOptions = [5, 10, 25, 50, 100];
const currentPage = ref(1);
const selectedResultsPerPage = ref(props.resultsPerPage);
const scrollContainer = ref<HTMLElement | null>(null);
const hasHorizontalOverflow = ref(false);
let resizeObserver: ResizeObserver | null = null;

const normalizedRows = computed(() =>
  props.rows.map((row) => (Array.isArray(row) ? row : row.rowData || [])),
);
const pagination = computed(() =>
  getTablePaginationState(
    normalizedRows.value.length,
    selectedResultsPerPage.value,
    currentPage.value,
  ),
);
const paginatedRows = computed(() =>
  paginateTableRows(
    normalizedRows.value,
    selectedResultsPerPage.value,
    currentPage.value,
  ),
);
const hasPreviousPage = computed(() => pagination.value.currentPage > 1);
const hasNextPage = computed(
  () => pagination.value.currentPage < pagination.value.totalPages,
);
const resultsPerPageId = computed(
  () => `${props.tableId}-results-per-page`,
);
const paginationAccessibleContext = computed(
  () => props.paginationContext || `du tableau « ${props.title} »`,
);
const scrollRegionLabel = computed(() =>
  hasHorizontalOverflow.value
    ? `${props.title}. Le tableau peut défiler horizontalement.`
    : undefined,
);
const paginationStatus = computed(() => {
  const { currentPage, firstResult, lastResult, totalPages } = pagination.value;
  const totalResults = normalizedRows.value.length;
  const pageSizeAnnouncement =
    `Affichage de ${selectedResultsPerPage.value} résultats par page.`;
  const prefix = props.statusPrefix.trim();
  const announcementStart = prefix
    ? `${prefix} ${pageSizeAnnouncement}`
    : pageSizeAnnouncement;

  if (totalResults === 0) {
    return `${announcementStart} Page 1 sur 1. Aucun résultat à afficher.`;
  }

  return `${announcementStart} Page ${currentPage} sur ${totalPages}. Résultats ${firstResult} à ${lastResult} sur ${totalResults}.`;
});

const getHeaderText = (header: string | Record<string, any>): string => {
  if (typeof header === 'object' && header !== null) {
    return String(header.text || header.label || header.key || '');
  }

  return String(header);
};

const getHeaderAttributes = (
  header: string | Record<string, any>,
): Record<string, any> => {
  return typeof header === 'object' && header !== null
    ? header.headerAttrs || {}
    : {};
};

const getRowAttributes = (visibleRowIndex: number): HTMLAttributes => {
  const sourceRowIndex = pagination.value.startIndex + visibleRowIndex;
  const sourceRow = props.rows[sourceRowIndex];

  return !Array.isArray(sourceRow) && sourceRow?.rowAttrs
    ? sourceRow.rowAttrs
    : {};
};

const isComponentCell = (cell: TableCell): cell is Record<string, any> => {
  return typeof cell === 'object' && cell !== null && Boolean(cell.component);
};

const getCellAttributes = (cell: TableCell): TdHTMLAttributes => {
  return typeof cell === 'object' && cell !== null && !cell.component
    ? cell.cellAttrs || {}
    : {};
};

const getComponentCellAttributes = (
  cell: Record<string, any>,
): Record<string, any> => {
  const { component: _component, text: _text, cellAttrs: _cellAttrs, ...attrs }
    = cell;

  return attrs;
};

const getCellText = (cell: TableCell): string => {
  if (cell === null || cell === undefined) {
    return '';
  }
  if (typeof cell === 'object') {
    return String(cell.text || '');
  }

  return String(cell);
};

function changeResultsPerPage(event: Event) {
  const value = Number((event.target as HTMLSelectElement).value);

  selectedResultsPerPage.value = value;
  currentPage.value = 1;
}

function goToPage(page: number) {
  currentPage.value = getTablePaginationState(
    normalizedRows.value.length,
    selectedResultsPerPage.value,
    page,
  ).currentPage;
}

function updateHorizontalOverflow() {
  const element = scrollContainer.value;
  hasHorizontalOverflow.value = Boolean(
    element && element.scrollWidth > element.clientWidth + 1,
  );
}

onMounted(() => {
  updateHorizontalOverflow();
  if (typeof ResizeObserver !== 'undefined' && scrollContainer.value) {
    resizeObserver = new ResizeObserver(updateHorizontalOverflow);
    resizeObserver.observe(scrollContainer.value);
  }
});

onBeforeUnmount(() => resizeObserver?.disconnect());

watch(
  () => props.rows,
  async () => {
    currentPage.value = 1;
    await nextTick();
    updateHorizontalOverflow();
  },
);
</script>

<template>
  <div class="accessible-data-table">
    <div
      class="fr-table fr-table--bordered fr-table--multiline"
      :class="[
        tableClass,
        { 'accessible-data-table--fixed': fixedLayout },
      ]"
    >
      <div class="fr-table__wrapper">
        <div class="fr-table__container">
          <div
            ref="scrollContainer"
            class="fr-table__content accessible-data-table__scroll"
            :role="hasHorizontalOverflow ? 'region' : undefined"
            :aria-label="scrollRegionLabel"
            :tabindex="hasHorizontalOverflow ? 0 : undefined"
          >
            <table :id="tableId">
              <caption>
                {{ title }}
              </caption>
              <thead>
                <tr>
                  <th
                    v-for="(header, index) of headers"
                    :key="getHeaderText(header) || index"
                    scope="col"
                    v-bind="getHeaderAttributes(header)"
                  >
                    {{ getHeaderText(header) }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(row, rowIndex) of paginatedRows"
                  :key="`${pagination.startIndex + rowIndex}-${getCellText(row[0])}`"
                  v-bind="getRowAttributes(rowIndex)"
                >
                  <template
                    v-for="(cell, cellIndex) of row"
                    :key="cellIndex"
                  >
                    <th
                      v-if="cellIndex === rowHeaderColumn"
                      scope="row"
                      v-bind="getCellAttributes(cell)"
                    >
                      <component
                        :is="cell.component"
                        v-if="isComponentCell(cell)"
                        v-bind="getComponentCellAttributes(cell)"
                      >
                        {{ getCellText(cell) }}
                      </component>
                      <template v-else>
                        {{ getCellText(cell) }}
                      </template>
                    </th>
                    <td v-else v-bind="getCellAttributes(cell)">
                      <component
                        :is="cell.component"
                        v-if="isComponentCell(cell)"
                        v-bind="getComponentCellAttributes(cell)"
                      >
                        {{ getCellText(cell) }}
                      </component>
                      <template v-else>
                        {{ getCellText(cell) }}
                      </template>
                    </td>
                  </template>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <div class="accessible-data-table__pagination">
      <div class="fr-select-group accessible-data-table__size">
        <label class="fr-label" :for="resultsPerPageId">
          Résultats par page (mise à jour automatique)
        </label>
        <select
          :id="resultsPerPageId"
          class="fr-select"
          :value="selectedResultsPerPage"
          :aria-controls="tableId"
          @change="changeResultsPerPage"
        >
          <option
            v-for="option of resultsPerPageOptions"
            :key="option"
            :value="option"
          >
            {{ option }}
          </option>
        </select>
      </div>

      <p
        class="accessible-data-table__status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {{ paginationStatus }}
      </p>

      <nav :aria-label="`Pagination ${paginationAccessibleContext}`">
        <ul class="accessible-data-table__controls">
          <li>
            <button
              class="fr-btn fr-btn--secondary"
              type="button"
              :aria-label="`Aller à la première page ${paginationAccessibleContext}`"
              :aria-controls="tableId"
              :disabled="!hasPreviousPage"
              @click="goToPage(1)"
            >
              Première page
            </button>
          </li>
          <li>
            <button
              class="fr-btn fr-btn--secondary"
              type="button"
              :aria-label="`Aller à la page précédente ${paginationAccessibleContext}`"
              :aria-controls="tableId"
              :disabled="!hasPreviousPage"
              @click="goToPage(currentPage - 1)"
            >
              Page précédente
            </button>
          </li>
          <li>
            <button
              class="fr-btn fr-btn--secondary"
              type="button"
              :aria-label="`Aller à la page suivante ${paginationAccessibleContext}`"
              :aria-controls="tableId"
              :disabled="!hasNextPage"
              @click="goToPage(currentPage + 1)"
            >
              Page suivante
            </button>
          </li>
          <li>
            <button
              class="fr-btn fr-btn--secondary"
              type="button"
              :aria-label="`Aller à la dernière page ${paginationAccessibleContext}`"
              :aria-controls="tableId"
              :disabled="!hasNextPage"
              @click="goToPage(pagination.totalPages)"
            >
              Dernière page
            </button>
          </li>
        </ul>
      </nav>
    </div>
  </div>
</template>

<style scoped lang="scss">
.accessible-data-table {
  max-width: 100%;
  min-width: 0;

  .fr-table {
    max-width: 100%;
  }

  &__scroll {
    max-width: 100%;
    overflow-x: auto;
  }

  &__scroll table {
    min-width: 36rem;
  }

  &__pagination {
    display: grid;
    gap: 1rem;
    min-width: 0;
  }

  &__size {
    width: min(100%, 24rem);
    margin-bottom: 0;
  }

  &__status {
    margin: 0;
  }

  &__controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  &__controls li {
    min-width: 0;
  }

  &__controls .fr-btn {
    max-width: 100%;
    white-space: normal;
  }
}

@media screen and (min-width: 768px) {
  .accessible-data-table--fixed table {
    table-layout: fixed;
  }
}

@media screen and (max-width: 767px) {
  .accessible-data-table__controls {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .accessible-data-table__controls li,
  .accessible-data-table__controls .fr-btn {
    width: 100%;
  }
}
</style>
