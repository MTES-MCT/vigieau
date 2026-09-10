import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { getStatisticSeriesStatusPresentation } from '../client/utils/statistic-series-status.ts';
import { findMissingStatisticPeriods } from '../client/utils/statistic-history-gaps.ts';
import { findProvisionalStatisticPeriods } from '../client/utils/statistic-provisional.ts';

const provisional = (date) => ({ date, dataStatus: 'provisional', dataStatusReason: 'historic-recalculation' });
const ready = { usable: true, currentFresh: true, latestDate: '2026-09-10' };
const updating = { ...ready, currentFresh: false };
const describeSeries = (series, options = {}) => getStatisticSeriesStatusPresentation(options.status ?? ready, {
  series,
  waterType: options.waterType ?? '',
  loading: options.loading ?? false,
  missingPeriods: findMissingStatisticPeriods(series),
  provisionalPeriods: findProvisionalStatisticPeriods(series),
});

test('summarizes the 52 provisional days in one short message with current refresh as a detail', () => {
  const series = Array.from({ length: 72 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 6, 1 + index)).toISOString().slice(0, 10);
    return date >= '2026-07-11' && date <= '2026-08-31' ? provisional(date) : { date };
  });
  assert.deepEqual(describeSeries(series, { status: updating }), {
    title: 'Donn\u00E9es provisoires',
    description: 'Les valeurs du 11/07/2026 au 31/08/2026 restent consultables pendant leur recalcul et peuvent \u00E9voluer.',
    type: 'info',
    details: ['Les donn\u00E9es affich\u00E9es restent consultables pendant leur actualisation.'],
  });
});

test('does not add a disclosure to a single provisional period without secondary signals', () => {
  assert.deepEqual(describeSeries([provisional('2026-07-11')]), {
    title: 'Donn\u00E9es provisoires',
    description: 'Les valeurs du 11/07/2026 restent consultables pendant leur recalcul et peuvent \u00E9voluer.',
    type: 'info',
    details: [],
  });
});

test('prioritizes real gaps over provisional and current-refresh signals without changing observations', () => {
  const series = [{ date: '2026-09-05' }, provisional('2026-09-06'), provisional('2026-09-08'), { date: '2026-09-10' }];
  const before = structuredClone(series);
  assert.deepEqual(describeSeries(series, { status: updating }), {
    title: 'Donn\u00E9es manquantes',
    description: 'Les donn\u00E9es manquantes ne signifient pas une absence de restrictions.',
    type: 'warning',
    details: [
      'Le 07/09/2026 : 1 jour sans donn\u00E9e.',
      'Le 09/09/2026 : 1 jour sans donn\u00E9e.',
      'Le 06/09/2026 : 1 jour de donn\u00E9es provisoires.',
      'Le 08/09/2026 : 1 jour de donn\u00E9es provisoires.',
      'Les donn\u00E9es affich\u00E9es restent consultables pendant leur actualisation.',
    ],
  });
  assert.deepEqual(series, before);
});

test('retains the exact established wording for a long missing period', () => {
  const result = describeSeries([{ date: '2026-07-10' }, { date: '2026-09-01' }]);
  assert.equal(result.details[0], 'Du 11/07/2026 au 31/08/2026 : 52 jours sans donn\u00E9e.');
});

test('lists multiple provisional periods under details, including certified dates between them', () => {
  const result = describeSeries([provisional('2026-07-01'), { date: '2026-07-02' }, provisional('2026-07-03'), provisional('2026-07-04')]);
  assert.equal(result.title, 'Donn\u00E9es provisoires');
  assert.equal(result.description, 'Certaines valeurs restent consultables pendant leur recalcul et peuvent \u00E9voluer.');
  assert.deepEqual(result.details, [
    'Le 01/07/2026 : 1 jour de donn\u00E9es provisoires.',
    'Du 03/07/2026 au 04/07/2026 : 2 jours de donn\u00E9es provisoires.',
  ]);
});

test('limits current refresh notice to the currently loaded series containing the latest date', () => {
  assert.equal(describeSeries([{ date: '2026-06-01' }], { status: updating }), null);
  assert.equal(describeSeries([{ date: '2026-09-10' }], { status: ready }), null);
  assert.equal(describeSeries([{ date: '2026-09-10' }], { status: { ...updating, latestDate: null } }), null);
  assert.deepEqual(describeSeries([{ date: '2026-09-10' }], { status: updating }), {
    title: 'Mise \u00E0 jour en cours',
    description: 'Les donn\u00E9es affich\u00E9es restent consultables pendant leur actualisation.',
    type: 'info',
    details: [],
  });
});

test('shows the potable-water limit only for displayed pre-cutoff dates and relevant water types', () => {
  for (const waterType of ['', 'AEP']) {
    assert.equal(describeSeries([{ date: '2024-04-27' }], { waterType }).title, 'Donn\u00E9es historiques sur l\u2019eau potable limit\u00E9es');
    assert.equal(describeSeries([{ date: '2024-04-28' }], { waterType }), null);
    assert.equal(describeSeries([{ date: '2026-07-01' }], { waterType }), null);
  }
  for (const waterType of ['SUP', 'SOU']) {
    assert.equal(describeSeries([{ date: '2024-04-27' }], { waterType }), null);
  }
});

test('keeps the potable-water limit as a detail when a more important signal exists', () => {
  const result = describeSeries([provisional('2024-04-27'), { date: '2024-04-28' }]);
  assert.equal(result.title, 'Donn\u00E9es provisoires');
  assert.deepEqual(result.details, ["Les donn\u00E9es sur l'eau potable ne sont pas disponibles avant le 28/04/2024."]);
});

test('does not claim loaded observations are unavailable when the global health endpoint is unavailable', () => {
  const status = { usable: false, currentFresh: false, latestDate: null, status: 'unavailable' };
  assert.equal(describeSeries([{ date: '2026-09-10' }], { status }), null);
  assert.equal(describeSeries([provisional('2026-09-10')], { status }).title, 'Donn\u00E9es provisoires');
});

test('leaves empty, failed and loading states to the chart without an additional data-quality alert', () => {
  assert.equal(describeSeries(null, { status: updating }), null);
  assert.equal(describeSeries([], { status: updating }), null);
  assert.equal(describeSeries([provisional('2026-07-11')], { loading: true, status: updating }), null);
});

test('wires only department observations into one alert inside the PNG area without pending form dates', async () => {
  const chart = await readFile(new URL('../client/components/donnees/DepartementChart.vue', import.meta.url), 'utf8');
  const page = await readFile(new URL('../client/pages/donnees/departement/index.vue', import.meta.url), 'utf8');
  const component = await readFile(new URL('../client/components/donnees/StatisticDataStatus.vue', import.meta.url), 'utf8');
  const surface = await readFile(new URL('../client/pages/donnees/surface/index.vue', import.meta.url), 'utf8');
  const notice = chart.match(/<DonneesStatisticDataStatus\s[^>]*\/>/g);
  assert.equal(notice.length, 1);
  assert.match(notice[0], /:series="dataDepartement"/);
  assert.match(notice[0], /:water-type="formData.typeEau"/);
  assert.match(notice[0], /:loading="loading"/);
  assert.doesNotMatch(notice[0], /dateDebut|dateFin|computeDisabled/);
  assert.ok(chart.indexOf(notice[0]) > chart.indexOf('<div ref="screenshotZone">'));
  assert.ok(chart.indexOf(notice[0]) < chart.indexOf('<Line id='));
  assert.doesNotMatch(chart, /<DonneesStatisticHistoryGaps|<DonneesStatisticProvisionalData|title="Donn\u00E9es historiques/);
  assert.doesNotMatch(page, /DonneesStatisticDataStatus/);
  assert.match(surface, /<DonneesStatisticDataStatus\s*\/>/);
  assert.equal((component.match(/<DsfrAlert\b/g) ?? []).length, 1);
  assert.match(component, /props.series === undefined\s*\? getStatisticStatusPresentation\(status.value\)/);
  assert.match(component, /statistic-series-status/);
  assert.match(component, /<summary>D\u00E9tails des donn\u00E9es<\/summary>/);
  assert.doesNotMatch(component.match(/<details[^>]*>/)?.[0] ?? '', /\bopen\b/);
  assert.match(component, /if \(props.series !== null\) loadStatus\(\)/);
  assert.match(component, /watch\(\(\) => props.series, \(series\) =>/);
  assert.match(component, /mounted && series !== undefined && series !== null/);
  assert.match(component, /request === latestStatusRequest/);
  assert.doesNotMatch(component, /setInterval|watch\(\(\) => props.waterType|watch\(\(\) => props.loading/);
});
