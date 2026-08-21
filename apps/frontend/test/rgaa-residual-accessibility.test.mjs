import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  getDailyStatisticsRows,
  getProfileStatisticsRows,
} from '../client/utils/statistics-accessibility.ts';

const readSource = relativePath => readFile(
  new URL(relativePath, import.meta.url),
  'utf8',
);

const sources = Object.fromEntries(await Promise.all(
  Object.entries({
    accessibility: '../client/pages/accessibilite/index.vue',
    areaChart: '../client/components/donnees/AreaChart.vue',
    communeBarChart: '../client/components/donnees/CommuneBarChart.vue',
    communeChart: '../client/components/donnees/CommuneChart.vue',
    communeMapTable: '../client/components/carte/commune/Table.vue',
    departmentChart: '../client/components/donnees/DepartementChart.vue',
    emailChambery: '../client/layouts/emails/chambery.vue',
    emailSmgc: '../client/layouts/emails/smgc.vue',
    lineChart: '../client/components/stats/LineChart.vue',
    loader: '../client/components/Loader.vue',
    profileChart: '../client/components/stats/ProfileRepartition.vue',
    table: '../client/components/AccessibleDataTable.vue',
  }).map(async ([name, path]) => [name, await readSource(path)]),
));

test('uses one model for the statistics charts and their detailed alternatives', () => {
  const stats = {
    statsByDay: [{
      arreteDownloads: 3,
      date: '2026-08-21',
      restrictionsSearch: 7,
      visits: 11,
    }],
    profileRepartition: {
      collectivite: 1,
      entreprise: 1,
      exploitation: 2,
      particulier: 4,
    },
  };

  assert.deepEqual(getDailyStatisticsRows(stats), [{
    arreteDownloads: 3,
    date: '2026-08-21',
    restrictionsSearch: 7,
    visits: 11,
  }]);
  assert.deepEqual(
    getProfileStatisticsRows(stats).map(({ count, percentage, profile }) => ({
      count,
      percentage,
      profile,
    })),
    [
      { count: 4, percentage: 50, profile: 'particulier' },
      { count: 2, percentage: 25, profile: 'exploitation' },
      { count: 1, percentage: 12.5, profile: 'entreprise' },
      { count: 1, percentage: 12.5, profile: 'collectivite' },
    ],
  );
  assert.equal(
    getProfileStatisticsRows({ profileRepartition: {} })
      .every(row => row.percentage === 0),
    true,
  );

  for (const source of [sources.lineChart, sources.profileChart]) {
    assert.match(source, /<figure>/);
    assert.match(source, /<figcaption/);
    assert.match(source, /aria-hidden="true"/);
    assert.match(source, /<AccessibleDataTable/);
  }
});

test('relates every public data chart to a complete table with unique IDs', () => {
  assert.match(sources.areaChart, /href="#area-restrictions-history-table"/);
  assert.match(sources.departmentChart, /href="#department-restrictions-history-table"/);
  assert.match(sources.communeBarChart, /:id="chartId"/);
  assert.match(sources.communeBarChart, /`#\$\{tableId\}`/);
  assert.match(sources.communeChart, /chart-id="commune-chart-all-water"/);
  assert.match(sources.communeChart, /`commune-chart-\$\{typeEau\.value\.toLowerCase\(\)\}`/);
  assert.doesNotMatch(sources.communeBarChart, /id="area-chart-line"/);
});

test('provides stable loading semantics and reduced motion', () => {
  assert.match(sources.loader, /:role="announce \? 'status' : undefined"/);
  assert.match(sources.loader, /aria-hidden="true"/);
  assert.match(sources.loader, /Chargement en cours/);
  assert.match(sources.loader, /prefers-reduced-motion: reduce/);
  for (const source of [sources.areaChart, sources.departmentChart, sources.communeChart]) {
    assert.match(source, /role="status"/);
    assert.match(source, /aria-live="polite"/);
    assert.match(source, /:aria-busy="loading"/);
  }
});

test('makes email routes part of the shared navigation contract', () => {
  for (const source of [sources.emailChambery, sources.emailSmgc]) {
    assert.match(source, /<DsfrSkipLinks/);
    assert.match(source, /<main id="main-content" role="main" tabindex="-1"/);
    assert.match(source, /getMandatoryFooterLinks/);
    assert.doesNotMatch(source, /serviceDescription="''"/);
  }
});

test('hardens row headers, scroll focus and the commune code label', () => {
  assert.match(sources.table, /rowHeaderColumn\?: number \| null/);
  assert.match(sources.table, /scope="row"/);
  assert.match(sources.table, /scrollWidth > element\.clientWidth/);
  assert.match(sources.table, /:tabindex="hasHorizontalOverflow \? 0 : undefined"/);
  assert.match(sources.communeMapTable, /Code INSEE/);
  assert.doesNotMatch(sources.communeMapTable, /const headers = \['Commune'/);
});

test('explains the declaration dates without inventing the missing 2025 audit evidence', () => {
  assert.match(sources.accessibility, /Établie initialement le/);
  assert.match(sources.accessibility, /mise à jour le/);
  assert.match(sources.accessibility, /Établissement de cette déclaration d’accessibilité/);
  assert.match(sources.accessibility, /Technologies utilisées pour la réalisation du site/);
  assert.doesNotMatch(sources.accessibility, /totalement conforme/i);
});
