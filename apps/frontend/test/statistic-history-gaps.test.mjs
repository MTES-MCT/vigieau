import assert from 'node:assert/strict';
import test from 'node:test';
import { LineController, LineElement } from 'chart.js';
import { findMissingStatisticPeriods, MAX_DAILY_STATISTIC_GAP_MS } from '../client/utils/statistic-history-gaps.ts';

const series = (...dates) => dates.map(date => ({ date }));

test('detects the 52 missing days without changing the API series or its values', () => {
  const data = [
    { date: '2026-09-01', AEP: { vigilance: '2.5', crise: 0 } },
    { date: '2026-07-10', AEP: { vigilance: 0, crise: 4 } },
    { date: '2026-07-10', AEP: { vigilance: 0, crise: 4 } },
  ];
  const before = structuredClone(data);
  assert.deepEqual(findMissingStatisticPeriods(data), [{ start: '2026-07-11', end: '2026-08-31', days: 52 }]);
  assert.deepEqual(data, before);
});

test('returns separate single-day and multi-day gaps, including across year boundaries', () => {
  assert.deepEqual(findMissingStatisticPeriods(series('2025-12-30', '2026-01-01', '2026-01-05')), [
    { start: '2025-12-31', end: '2025-12-31', days: 1 },
    { start: '2026-01-02', end: '2026-01-04', days: 3 },
  ]);
});

test('does not invent missing coverage outside the observed dates', () => {
  for (const data of [null, [], series('2026-08-01'), series('2026-08-01', '2026-08-02')]) {
    assert.deepEqual(findMissingStatisticPeriods(data), []);
  }
});

test('uses calendar days across leap years and daylight-saving transitions', () => {
  for (const dates of [
    ['2024-02-28', '2024-02-29', '2024-03-01'],
    ['2026-03-28', '2026-03-29', '2026-03-30'],
    ['2026-10-24', '2026-10-25', '2026-10-26'],
  ]) {
    assert.deepEqual(findMissingStatisticPeriods(series(...dates)), []);
  }
  assert.deepEqual(findMissingStatisticPeriods(series('2024-02-28', '2024-03-01')), [
    { start: '2024-02-29', end: '2024-02-29', days: 1 },
  ]);
  assert.deepEqual(findMissingStatisticPeriods(series('2026-10-24', '2026-10-26')), [
    { start: '2026-10-25', end: '2026-10-25', days: 1 },
  ]);
});

test('ignores invalid calendar dates instead of normalizing them into observations', () => {
  assert.deepEqual(findMissingStatisticPeriods(series('2026-02-28', '2026-02-30', 'invalid', '2026-03-02')), [
    { start: '2026-03-01', end: '2026-03-01', days: 1 },
  ]);
});

function chartSegments(timestamps, spanGaps = MAX_DAILY_STATISTIC_GAP_MS) {
  const parsed = timestamps.map(x => ({ x, y: 2 }));
  const points = parsed.map(() => ({}));
  const controller = {
    _cachedMeta: {
      iScale: { axis: 'x', getPixelForValue: x => x },
      vScale: { axis: 'y', getBasePixel: () => 0, getPixelForValue: y => y },
    },
    _getSharedOptions: () => ({ includeOptions: false }),
    options: { spanGaps },
    chart: { _animationsDisabled: true },
    getParsed: index => parsed[index],
  };
  LineController.prototype.updateElements.call(controller, points, 0, points.length, 'none');
  const line = new LineElement({ options: { spanGaps } });
  line.points = points;
  return line.segments.map(({ start, end }) => ({ start, end }));
}

test('Chart.js separates line and filler segments over absent dates without placeholder zeroes', () => {
  const timestamps = ['2026-07-09', '2026-07-10', '2026-09-01', '2026-09-02'].map(Date.parse);
  assert.deepEqual(chartSegments(timestamps, false), [{ start: 0, end: 3 }]);
  assert.deepEqual(chartSegments(timestamps), [{ start: 0, end: 1 }, { start: 2, end: 3 }]);
});

test('Chart.js keeps consecutive daily observations connected, including 23-hour and 25-hour days', () => {
  const hour = 60 * 60 * 1000;
  assert.deepEqual(chartSegments([0, 24 * hour, 47 * hour, 72 * hour]), [{ start: 0, end: 3 }]);
  assert.deepEqual(chartSegments([0, 24 * hour, 71 * hour, 95 * hour]), [{ start: 0, end: 1 }, { start: 2, end: 3 }]);
});
