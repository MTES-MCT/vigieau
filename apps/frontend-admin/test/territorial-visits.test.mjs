import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateTerritorialVisits } from '../client/utils/territorial-visits.ts';

test('adds visits by date and counts each date once per department', () => {
  const result = aggregateTerritorialVisits([
    { visits: [{ date: '2026-11-19', visits: 4 }, { date: '2026-11-19', visits: 6 }] },
    { visits: [{ date: '2026-11-19', visits: 9 }, { date: '2026-11-18', visits: null }] },
    { visits: null },
    { visits: [{ date: 'unknown', visits: 7 }] },
  ]);
  assert.deepEqual(result, [{ date: '2026-11-18', visits: 0 }, { date: '2026-11-19', visits: 13 }]);
});

test('renders the national series when the number of observations exceeds a browser argument list', () => {
  const visits = Array.from({ length: 1_300 }, (_, day) => ({
    date: new Date(Date.UTC(2023, 6, 12 + day)).toISOString().slice(0, 10), visits: 1,
  }));
  const result = aggregateTerritorialVisits(Array.from({ length: 101 }, () => ({ visits })));
  assert.equal(result.length, visits.length);
  assert.equal(result[0].date, '2023-07-12');
  assert.ok(result.every(({ visits: count }) => count === 101));
});
