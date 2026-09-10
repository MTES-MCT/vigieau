import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { findProvisionalStatisticPeriods, getStatisticPointStyle, getStatisticRowStatusLabel } from '../client/utils/statistic-provisional.ts';
import { findMissingStatisticPeriods } from '../client/utils/statistic-history-gaps.ts';
import { isAreaStatisticSeries, isDepartmentStatisticSeries } from '../client/utils/statistic-series.ts';

const provisional = (date) => ({ date, dataStatus: 'provisional', dataStatusReason: 'historic-recalculation' });

test('groups only supplied provisional dates without modifying values or filling missing days', () => {
  const data = [
    { ...provisional('2026-08-03'), AEP: { crise: 7 } },
    { date: '2026-08-01' },
    provisional('2026-08-02'),
    provisional('2026-08-02'),
    provisional('2026-08-05'),
    { date: '2026-08-06' },
  ];
  const before = structuredClone(data);
  assert.deepEqual(findProvisionalStatisticPeriods(data), [
    { start: '2026-08-02', end: '2026-08-03', days: 2 },
    { start: '2026-08-05', end: '2026-08-05', days: 1 },
  ]);
  assert.deepEqual(findMissingStatisticPeriods(data), [{ start: '2026-08-04', end: '2026-08-04', days: 1 }]);
  assert.deepEqual(data, before);
});

test('does not report certified or invalid dates as provisional periods', () => {
  for (const data of [null, [], [{ date: '2026-08-01' }], [provisional('2026-02-30'), provisional('invalid')]]) {
    assert.deepEqual(findProvisionalStatisticPeriods(data), []);
  }
  assert.deepEqual(findProvisionalStatisticPeriods([provisional('2025-12-31'), provisional('2026-01-01')]), [
    { start: '2025-12-31', end: '2026-01-01', days: 2 },
  ]);
});

test('distinguishes provisional observations in tooltips and exports, not by global health', () => {
  assert.equal(getStatisticRowStatusLabel(provisional('2026-08-01')), 'Provisoire (recalcul en cours)');
  assert.equal(getStatisticRowStatusLabel({ date: '2026-08-02' }), 'Certifi\u00E9e');
});

test('distinguishes provisional points without modifying the chart line or filler segmentation', () => {
  assert.equal(getStatisticPointStyle(provisional('2026-08-02')), 'triangle');
  assert.equal(getStatisticPointStyle({ date: '2026-08-03' }), 'circle');
  assert.equal(getStatisticPointStyle(undefined), 'circle');
});

test('accepts explicit provisional metadata and rejects unknown or incomplete status metadata', () => {
  const area = { date: '2026-08-01', AEP: { vigilance: 0, alerte: 1, alerte_renforcee: 2, crise: 3 } };
  const department = { date: '2026-08-01', departements: [{ niveauGravite: 'crise', niveauGraviteSup: 'alerte', niveauGraviteSou: null, niveauGraviteAep: null }] };
  for (const [row, validate] of [[area, (data) => isAreaStatisticSeries(data, 'AEP')], [department, isDepartmentStatisticSeries]]) {
    assert.equal(validate([row]), true);
    assert.equal(validate([{ ...row, ...provisional(row.date) }]), true);
    for (const metadata of [
      { dataStatus: 'unknown' },
      { dataStatus: 'provisional' },
      { dataStatus: 'provisional', dataStatusReason: 'unknown' },
      { dataStatusReason: 'historic-recalculation' },
    ]) {
      assert.equal(validate([{ ...row, ...metadata }]), false);
    }
  }
});

test('limits provisional opt-in to the two aggregate chart consumers and includes their warning in PNG capture', async () => {
  const api = await readFile(new URL('../client/api/index.ts', import.meta.url), 'utf8');
  assert.equal((api.match(/includeProvisional = false/g) ?? []).length, 2);
  for (const name of ['Area', 'Departement']) {
    const chart = await readFile(new URL(`../client/components/donnees/${name}Chart.vue`, import.meta.url), 'utf8');
    assert.match(chart, new RegExp(`api.getData${name}\\(formData.dateDebut, formData.dateFin, formData.area, true\\)`));
    assert.match(chart, /spanGaps: MAX_DAILY_STATISTIC_GAP_MS/);
    assert.match(chart, /pointStyle:.*getStatisticPointStyle/);
    // Chart.js scriptable segments reconnect numeric spanGaps, including their fill.
    assert.doesNotMatch(chart, /segment:\s*\{/);
    const notice = name === 'Departement' ? '<DonneesStatisticDataStatus' : '<DonneesStatisticProvisionalData';
    assert.ok(chart.indexOf(notice) > chart.indexOf('<div ref="screenshotZone">'));
    assert.ok(chart.indexOf(notice) < chart.indexOf('<Line id='));
    const table = await readFile(new URL(`../client/components/donnees/${name}Table.vue`, import.meta.url), 'utf8');
    assert.match(table, /hasProvisionalData.value \? \{ statut: getStatisticRowStatusLabel\(stat\) \} : \{\}/);
  }
});
