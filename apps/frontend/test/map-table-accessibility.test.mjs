import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  getTablePaginationState,
  paginateTableRows,
} from '../client/utils/table-pagination.ts';

const componentsDirectory = fileURLToPath(
  new URL('../client/components/', import.meta.url),
);
const tableSource = await readFile(
  new URL('../client/components/carte/Table.vue', import.meta.url),
  'utf8',
);
const accessibleTableSource = await readFile(
  new URL('../client/components/AccessibleDataTable.vue', import.meta.url),
  'utf8',
);
const statisticsTableSource = await readFile(
  new URL('../client/components/stats/DepartementTable.vue', import.meta.url),
  'utf8',
);
const restrictionOrdersSource = await readFile(
  new URL(
    '../client/components/donnees/ArretesRestrictionsTable.vue',
    import.meta.url,
  ),
  'utf8',
);

async function findVueFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return findVueFiles(entryPath);
      }

      return entry.name.endsWith('.vue') ? [entryPath] : [];
    }),
  );

  return files.flat();
}

test('keeps every restriction level and its department count in one list item', () => {
  const summary = tableSource.match(
    /<ul class="departement-card-list[\s\S]*?<\/ul>/,
  )?.[0];

  assert.ok(summary);
  assert.match(
    summary,
    /<li[\s\S]*?v-for="resume of dataResume"[\s\S]*?<DsfrBadge[\s\S]*?formatDepartmentCount\(resume\.number\)[\s\S]*?<\/li>/,
  );
  assert.equal((summary.match(/<li\b/g) ?? []).length, 1);
  assert.doesNotMatch(summary, /<ul\b[^>]*>[\s\S]*<ul\b/);
});

test('uses a native named filter and one stable status region', () => {
  assert.match(
    tableSource,
    /<form[\s\S]*?role="search"[\s\S]*?@submit\.prevent="filterDepartments"/,
  );
  assert.match(
    tableSource,
    /<label class="fr-label" for="department-filter">[\s\S]*?Rechercher un département[\s\S]*?<\/label>/,
  );
  assert.match(
    tableSource,
    /<input[\s\S]*?id="department-filter"[\s\S]*?type="search"/,
  );
  assert.match(
    tableSource,
    /<button[\s\S]*?type="submit"[\s\S]*?Rechercher un département[\s\S]*?<\/button>/,
  );
  assert.match(tableSource, /:status-prefix="filterStatus"/);
  assert.equal((tableSource.match(/role="status"/g) ?? []).length, 0);
  assert.equal(
    (accessibleTableSource.match(/role="status"/g) ?? []).length,
    1,
  );
  assert.equal(
    (accessibleTableSource.match(/aria-live="polite"/g) ?? []).length,
    1,
  );
});

test('renders a simple captioned table with pagination outside the table', () => {
  const table = accessibleTableSource.match(
    /<table :id="tableId">[\s\S]*?<\/table>/,
  )?.[0];
  const body = table?.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0];

  assert.ok(table);
  assert.ok(body);
  assert.match(table, /<caption>[\s\S]*?title[\s\S]*?<\/caption>/);
  assert.match(table, /<th[\s\S]*?scope="col"/);
  assert.doesNotMatch(table, /<nav\b|resultsPerPageId/);
  assert.doesNotMatch(body, /\bcolspan=|<(?:button|select|nav)\b/);
  assert.ok(
    accessibleTableSource.indexOf('<nav :aria-label="`Pagination') >
      accessibleTableSource.indexOf('</table>'),
  );
});

test('labels automatic page sizing and names every bounded action', () => {
  assert.match(
    accessibleTableSource,
    /<label class="fr-label" :for="resultsPerPageId">[\s\S]*?Résultats par page \(mise à jour automatique\)[\s\S]*?<\/label>/,
  );
  assert.match(
    accessibleTableSource,
    /<select[\s\S]*?:id="resultsPerPageId"[\s\S]*?:aria-controls="tableId"/,
  );

  for (const action of [
    'première page',
    'page précédente',
    'page suivante',
    'dernière page',
  ]) {
    assert.match(
      accessibleTableSource,
      new RegExp(`Aller à la ${action} \\$\\{paginationAccessibleContext\\}`),
    );
  }

  assert.equal(
    (accessibleTableSource.match(/:disabled="!hasPreviousPage"/g) ?? [])
      .length,
    2,
  );
  assert.equal(
    (accessibleTableSource.match(/:disabled="!hasNextPage"/g) ?? []).length,
    2,
  );
});

test('derives collision-free control IDs from each required table ID', async () => {
  const vueFiles = await findVueFiles(componentsDirectory);
  const tableIds = [];

  for (const file of vueFiles) {
    const source = await readFile(file, 'utf8');
    const ids = [...source.matchAll(/<AccessibleDataTable\s[\s\S]*?table-id="([^"]+)"[\s\S]*?\/>/g)]
      .map(match => match[1]);

    tableIds.push(...ids);
  }

  assert.equal(tableIds.length, 7);
  assert.equal(new Set(tableIds).size, tableIds.length);
  assert.match(
    accessibleTableSource,
    /`\$\{props\.tableId\}-results-per-page`/,
  );
  assert.doesNotMatch(
    accessibleTableSource,
    /id="(?:pagination-options|results-per-page)"/,
  );
});

test('preserves dynamic link cells and their attributes', () => {
  assert.match(
    restrictionOrdersSource,
    /component: 'a'[\s\S]*?text: `Ouvrir l'arrêté`[\s\S]*?href: d\.fichier\.url[\s\S]*?target: '_blank'/,
  );
  assert.match(
    accessibleTableSource,
    /<component[\s\S]*?:is="cell\.component"[\s\S]*?v-if="isComponentCell\(cell\)"[\s\S]*?v-bind="getComponentCellAttributes\(cell\)"/,
  );
  assert.match(
    accessibleTableSource,
    /const \{ component: _component, text: _text, cellAttrs: _cellAttrs, \.\.\.attrs \}/,
  );
});

test('keeps data, pagination and export available in the light variant', () => {
  assert.equal((tableSource.match(/v-if="!light"/g) ?? []).length, 1);
  assert.match(tableSource, /v-if="!light"[\s\S]*?role="search"/);
  assert.match(tableSource, /<AccessibleDataTable/);
  assert.match(tableSource, /table-id="departments-table"/);
  assert.match(tableSource, /Télécharger les données \(CSV\)/);
});

test('gives the public statistics filter a label, specific action and status', () => {
  assert.match(
    statisticsTableSource,
    /<form[\s\S]*?role="search"[\s\S]*?@submit\.prevent="filterDepartments"/,
  );
  assert.match(
    statisticsTableSource,
    /<label class="fr-label" for="department-stats-filter">[\s\S]*?Rechercher un département dans les statistiques/,
  );
  assert.match(
    statisticsTableSource,
    /<button[\s\S]*?type="submit"[\s\S]*?Rechercher un département dans les statistiques/,
  );
  assert.match(statisticsTableSource, /:status-prefix="filterStatus"/);
  assert.match(
    statisticsTableSource,
    /title="Répartition des recherches par département"/,
  );
});

test('removes invalid DSFR pagination from every public component', async () => {
  const vueFiles = await findVueFiles(componentsDirectory);
  const violations = [];

  for (const file of vueFiles) {
    const source = await readFile(file, 'utf8');
    const dsfrTables = source.match(/<DsfrTable\b[\s\S]*?\/>/g) ?? [];

    if (dsfrTables.some(markup => /:pagination="true"/.test(markup))) {
      violations.push(path.relative(componentsDirectory, file));
    }
  }

  assert.deepEqual(violations, []);
});

test('announces the selected page size even when page and range stay unchanged', () => {
  assert.match(
    accessibleTableSource,
    /Affichage de \$\{selectedResultsPerPage\.value\} résultats par page/,
  );
  assert.match(
    accessibleTableSource,
    /function changeResultsPerPage[\s\S]*?selectedResultsPerPage\.value = value;[\s\S]*?currentPage\.value = 1;/,
  );
});

test('computes a valid page and result range for any page size', () => {
  assert.deepEqual(getTablePaginationState(26, 10, 2), {
    currentPage: 2,
    endIndex: 20,
    firstResult: 11,
    lastResult: 20,
    startIndex: 10,
    totalPages: 3,
  });
  assert.deepEqual(getTablePaginationState(26, 25, 3), {
    currentPage: 2,
    endIndex: 26,
    firstResult: 26,
    lastResult: 26,
    startIndex: 25,
    totalPages: 2,
  });
  assert.deepEqual(getTablePaginationState(0, 10, 12), {
    currentPage: 1,
    endIndex: 0,
    firstResult: 0,
    lastResult: 0,
    startIndex: 0,
    totalPages: 1,
  });
});

test('returns only rows belonging to the current valid page', () => {
  const rows = Array.from({ length: 26 }, (_value, index) => index + 1);

  assert.deepEqual(paginateTableRows(rows, 10, 2), [
    11,
    12,
    13,
    14,
    15,
    16,
    17,
    18,
    19,
    20,
  ]);
  assert.deepEqual(paginateTableRows(rows, 25, 3), [26]);
});
