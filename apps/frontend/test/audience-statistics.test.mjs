import assert from 'node:assert/strict';
import test from 'node:test';
import {
  knownCounts,
  normalizeAudienceStatistics,
  repartitionColor,
  repartitionScale,
  statisticCount,
  statisticPercentage,
  sumKnownCounts,
} from '../client/utils/audience-statistics.ts';

test('keeps zero observations distinct from missing or invalid measurements', () => {
  assert.equal(statisticCount(0), 0);
  for (const value of [null, undefined, '', '12', Number.NaN, Infinity, -1]) assert.equal(statisticCount(value), null);
  assert.deepEqual(knownCounts({ '01': 0, '02': 4, '03': null, '04': Infinity }), { '01': 0, '02': 4 });
  assert.equal(sumKnownCounts([]), null);
  assert.equal(sumKnownCounts([null, undefined]), null);
  assert.equal(sumKnownCounts([0, null]), 0);
  assert.equal(sumKnownCounts([2, null, 3]), 5);
});

test('does not invent percentages for absent or zero totals', () => {
  assert.equal(statisticPercentage(4, 8), '50.00%');
  assert.equal(statisticPercentage(0, 8), '0.00%');
  for (const total of [0, null, Number.NaN]) assert.equal(statisticPercentage(0, total), 'Non disponible');
  assert.equal(statisticPercentage(null, 8), 'Non disponible');
});

test('produces finite colors for empty, singleton, equal and zero distributions', () => {
  assert.equal(repartitionScale({}), null);
  for (const repartition of [{ '01': 0 }, { '01': 5 }, { '01': 5, '02': 5 }, { '01': 0, '02': 5 }]) {
    const scale = repartitionScale(repartition);
    for (const count of Object.values(repartition)) {
      assert.match(repartitionColor(count, scale), /^rgb\(\d+, \d+, \d+\)$/);
      assert.doesNotMatch(repartitionColor(count, scale), /NaN|Infinity/);
    }
  }
  assert.equal(repartitionColor(5, { min: 5, max: 5 }), 'rgb(49, 49, 120)');
});

test('normalizes the actual missing-data response without turning null into zero', () => {
  const statistics = normalizeAudienceStatistics({
    subscriptions: 0, profileRepartition: {}, departementRepartition: {}, regionRepartition: {},
    statsByDay: [{ date: '2026-10-24', visits: null, arreteDownloads: null, restrictionsSearch: null }],
  });
  assert.equal(statistics.subscriptions, 0);
  assert.equal(statistics.statsByDay[0].visits, null);
  assert.equal(sumKnownCounts(statistics.statsByDay.map(day => day.visits)), null);
  assert.equal(statistics.period, null);
  assert.equal(statistics.lastDataDate, null);
  assert.equal(normalizeAudienceStatistics({ subscriptions: null }).subscriptions, null);
  for (const value of [null, [], undefined, false]) assert.equal(normalizeAudienceStatistics(value), null);
});

test('rejects invalid calendar dates before formatting and falls back to observed dates', () => {
  const statistics = normalizeAudienceStatistics({
    period: { from: '2026-13-99', to: 'not a date' }, lastDataDate: '2026-02-30',
    statsByDay: [{ date: '2026-02-30', visits: 9 }, { date: 'invalid', visits: 2 }, { date: '2026-09-01', visits: 5 }],
  });
  assert.equal(statistics.statsByDay.length, 1);
  assert.deepEqual(statistics.period, { from: '2026-09-01', to: '2026-09-01' });
  assert.equal(statistics.lastDataDate, '2026-09-01');
  assert.equal(normalizeAudienceStatistics({ period: { from: '2026-10-02', to: '2026-10-01' } }).period, null);
});

test('keeps the supplied reporting period and stale date instead of claiming current data', () => {
  const statistics = normalizeAudienceStatistics({
    period: { from: '2026-08-03', to: '2026-09-01' }, lastDataDate: '2026-09-01', stale: true, partial: true,
    subscriptions: 5, statsByDay: [{ date: '2026-09-01', visits: 0 }],
  });
  assert.deepEqual(statistics.period, { from: '2026-08-03', to: '2026-09-01' });
  assert.equal(statistics.lastDataDate, '2026-09-01');
  assert.equal(statistics.stale, true);
  assert.equal(statistics.partial, true);
  assert.equal(statistics.statsByDay[0].visits, 0);
  assert.equal(statistics.statsByDay[0].arreteDownloads, null);
});
