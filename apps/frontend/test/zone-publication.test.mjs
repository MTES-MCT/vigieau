import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLegacyPmtilesUrl,
  buildPublishedZonePath,
  classifyManifestFailure,
  createLocalDateRollover,
  fetchLegacyPmtilesEtag,
  formatLocalCivilDate,
  getDepartmentsApiDate,
  getHttpErrorStatus,
  getManifestFailureAction,
  getMapPublicationStateKey,
  getNextSuccessfulRefreshVersion,
  isCurrentMapDate,
  isZonePublication,
  resolveCurrentZonePmtilesUrl,
  selectLegacyPmtilesEtag,
  shouldRefreshZonePublication,
  shouldReplaceZoneLayers,
  ZONE_PUBLICATION_LEGACY_HEAD_TIMEOUT_MS,
} from '../client/utils/zone-publication.ts';

const validPublication = {
  id: '29959a00-0000-4000-8000-000000000000',
  revision: '42',
  sourceRevision: '41',
  historicComputeEpoch: '9',
  pmtilesUrl: 'https://example.test/zones/42.pmtiles',
  pmtilesChecksum: 'a'.repeat(64),
};

test('validates a complete publication manifest', () => {
  assert.equal(isZonePublication(validPublication), true);
  assert.equal(isZonePublication({ ...validPublication, id: '' }), false);
  assert.equal(isZonePublication({ ...validPublication, revision: 42 }), false);
  assert.equal(
    isZonePublication({ ...validPublication, sourceRevision: 'invalid' }),
    false,
  );
  assert.equal(
    isZonePublication({ ...validPublication, historicComputeEpoch: 'bad' }),
    false,
  );
  assert.equal(
    isZonePublication({ ...validPublication, pmtilesChecksum: '' }),
    false,
  );
});

test('accepts an older API 200 and preserves its current PMTiles URL', () => {
  const legacyApiPublication = {
    ...validPublication,
    sourceRevision: undefined,
    historicComputeEpoch: undefined,
  };

  assert.equal(isZonePublication(legacyApiPublication), true);
  assert.equal(
    resolveCurrentZonePmtilesUrl(
      legacyApiPublication,
      false,
      'https://example.test/zones/legacy.pmtiles',
      null,
    ),
    validPublication.pmtilesUrl,
  );
});

test('extracts an HTTP status from ofetch and Nuxt errors', () => {
  assert.equal(getHttpErrorStatus({ response: { status: 404 } }), 404);
  assert.equal(getHttpErrorStatus({ statusCode: 410 }), 410);
  assert.equal(getHttpErrorStatus({ status: 503 }), 503);
  assert.equal(getHttpErrorStatus(new Error('network')), undefined);
});

test('allows the legacy fallback for old API route responses', () => {
  assert.equal(
    classifyManifestFailure({ response: { status: 400 } }),
    'legacy',
  );
  assert.equal(
    classifyManifestFailure({ response: { status: 404 } }),
    'legacy',
  );
  assert.equal(classifyManifestFailure({ statusCode: 500 }), 'error');
  assert.equal(classifyManifestFailure(new Error('network')), 'error');
});

test('switches a cached versioned publication to legacy on an old API response', () => {
  const failure = classifyManifestFailure(
    { response: { status: 404 } },
    true,
  );
  assert.equal(failure, 'legacy');
  assert.equal(
    getManifestFailureAction(failure, true),
    'legacy',
  );
  const legacyEtag = selectLegacyPmtilesEtag(null, '"legacy-etag"');
  assert.equal(
    buildLegacyPmtilesUrl(
      'https://example.test/zones/current.pmtiles',
      legacyEtag,
    ),
    'https://example.test/zones/current.pmtiles?etag=%22legacy-etag%22',
  );
});

test('keeps the last valid publication when a transient refresh fails', () => {
  assert.equal(classifyManifestFailure({ statusCode: 503 }, true), 'keep');
  assert.equal(classifyManifestFailure(new Error('network'), true), 'keep');
});

test('rejects a failed forced refresh while non-forced reads may use cache', () => {
  assert.equal(getManifestFailureAction('keep', true), 'throw');
  assert.equal(getManifestFailureAction('keep', false), 'serve-cache');
  assert.equal(getManifestFailureAction('legacy', false), 'legacy');
  assert.equal(getManifestFailureAction('error', false), 'throw');
});

test('signals only successful forced manifest refreshes', () => {
  assert.equal(getNextSuccessfulRefreshVersion(4, false), 4);
  assert.equal(getNextSuccessfulRefreshVersion(4, true), 5);
});

test('versions the legacy PMTiles URL only when an ETag is available', () => {
  const currentUrl = 'https://example.test/zones/current.pmtiles?source=legacy';

  assert.equal(buildLegacyPmtilesUrl(currentUrl, null), currentUrl);
  assert.equal(
    buildLegacyPmtilesUrl(currentUrl, '"etag-42"'),
    'https://example.test/zones/current.pmtiles?source=legacy&etag=%22etag-42%22',
  );
});

test('keeps the previous legacy PMTiles ETag when HEAD returns none', () => {
  assert.equal(selectLegacyPmtilesEtag(null, ' "etag-42" '), '"etag-42"');
  assert.equal(
    selectLegacyPmtilesEtag('"etag-42"', null),
    '"etag-42"',
  );
  assert.equal(
    selectLegacyPmtilesEtag('"etag-42"', '   '),
    '"etag-42"',
  );
  assert.equal(
    selectLegacyPmtilesEtag('"etag-42"', '"etag-43"'),
    '"etag-43"',
  );
});

test('reads the legacy PMTiles ETag with an uncached HEAD request', async () => {
  const calls = [];
  const etag = await fetchLegacyPmtilesEtag(
    'https://example.test/zones/current.pmtiles',
    async (url, options) => {
      calls.push({ url, options });
      return {
        headers: new Headers({ etag: ' "etag-42" ' }),
      };
    },
  );

  assert.equal(etag, '"etag-42"');
  assert.deepEqual(calls, [
    {
      url: 'https://example.test/zones/current.pmtiles',
      options: {
        method: 'HEAD',
        cache: 'no-store',
        retry: 0,
        timeout: ZONE_PUBLICATION_LEGACY_HEAD_TIMEOUT_MS,
      },
    },
  ]);
});

test('ignores a failed legacy PMTiles HEAD request', async () => {
  const etag = await fetchLegacyPmtilesEtag(
    'https://example.test/zones/current.pmtiles',
    async () => {
      throw new Error('network unavailable');
    },
  );

  assert.equal(etag, null);
});

test('treats a missing date as the current map view', () => {
  const today = new Date();
  const currentDate = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-');

  assert.equal(isCurrentMapDate(), true);
  assert.equal(isCurrentMapDate(currentDate), true);
  assert.equal(isCurrentMapDate('2012-01-01'), false);
});

test('parses YYYY-MM-DD as a valid local civil date', () => {
  const localNoon = new Date(2026, 6, 31, 12, 0, 0);

  assert.equal(isCurrentMapDate('2026-07-31', localNoon), true);
  assert.equal(isCurrentMapDate('2026-07-30', localNoon), false);
  assert.equal(isCurrentMapDate('2026-02-31', localNoon), false);
  assert.equal(isCurrentMapDate('not-a-date', localNoon), false);
});

test('formats the current civil date in the browser timezone', (context) => {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const caseByTimezone = {
    'Europe/Paris': {
      now: new Date('2026-07-30T22:30:00Z'),
      expected: '2026-07-31',
    },
    'America/Martinique': {
      now: new Date('2026-07-31T01:00:00Z'),
      expected: '2026-07-30',
    },
  };
  const testCase = caseByTimezone[timezone];

  if (!testCase) {
    context.skip(`timezone covered by dedicated runs: ${timezone}`);
    return;
  }
  const localDate = formatLocalCivilDate(testCase.now);
  assert.equal(localDate, testCase.expected);
  assert.equal(isCurrentMapDate(localDate, testCase.now), true);
  assert.equal(
    isCurrentMapDate(testCase.now.toISOString().split('T')[0], testCase.now),
    false,
  );
});

test('translates only the current local department date to the UTC API key', (context) => {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const caseByTimezone = {
    'Europe/Paris': {
      now: new Date('2026-07-30T22:30:00Z'),
      requestedDate: '2026-07-31',
      expectedApiDate: '2026-07-30',
    },
    'America/Martinique': {
      now: new Date('2026-08-01T00:30:00Z'),
      requestedDate: '2026-07-31',
      expectedApiDate: '2026-08-01',
    },
  };
  const testCase = caseByTimezone[timezone];

  if (!testCase) {
    context.skip(`timezone covered by dedicated runs: ${timezone}`);
    return;
  }
  assert.equal(
    getDepartmentsApiDate(testCase.requestedDate, testCase.now),
    testCase.expectedApiDate,
  );
  assert.equal(getDepartmentsApiDate('2026-07-15', testCase.now), '2026-07-15');
});

test('notifies a local civil date rollover only once', () => {
  let now = new Date(2026, 6, 31, 23, 59, 30);
  let scheduledCheck;
  let clearedInterval;
  const rollovers = [];
  const rollover = createLocalDateRollover(
    (currentDate, previousDate) => {
      rollovers.push({ currentDate, previousDate });
    },
    {
      now: () => now,
      intervalMs: 1_000,
      setIntervalFn: (callback, delay) => {
        assert.equal(delay, 1_000);
        scheduledCheck = callback;
        return 42;
      },
      clearIntervalFn: (interval) => {
        clearedInterval = interval;
      },
    },
  );

  scheduledCheck();
  assert.deepEqual(rollovers, []);
  now = new Date(2026, 7, 1, 0, 0, 5);
  scheduledCheck();
  rollover.check();
  assert.deepEqual(rollovers, [
    { currentDate: '2026-08-01', previousDate: '2026-07-31' },
  ]);

  rollover.stop();
  assert.equal(clearedInterval, 42);
});

test('replaces map layers only when their publication source changes', () => {
  const currentUrl = 'https://example.test/zones/42.pmtiles';

  assert.equal(shouldReplaceZoneLayers(null, currentUrl, false), true);
  assert.equal(shouldReplaceZoneLayers(currentUrl, currentUrl, true), false);
  assert.equal(
    shouldReplaceZoneLayers(
      currentUrl,
      'https://example.test/zones/43.pmtiles',
      true,
    ),
    true,
  );
  assert.equal(shouldReplaceZoneLayers(currentUrl, currentUrl, false), true);
});

test('pins a zone request to the selected publication', () => {
  const originalParams = new URLSearchParams({ commune: '65440' });

  assert.equal(
    buildPublishedZonePath(
      '/zones',
      originalParams,
      '29959a00-0000-4000-8000-000000000000',
    ),
    '/zones?commune=65440&publicationId=29959a00-0000-4000-8000-000000000000',
  );
  assert.equal(originalParams.has('publicationId'), false);
  assert.equal(
    buildPublishedZonePath('/zones', originalParams, null),
    '/zones?commune=65440',
  );
});

test('does not refresh a publication pinned by the displayed map', () => {
  assert.equal(shouldRefreshZonePublication(410, true), false);
  assert.equal(shouldRefreshZonePublication(410, false), true);
  assert.equal(shouldRefreshZonePublication(503, false), false);
});

test('detects the manifest error to legacy map transition', () => {
  const failedState = getMapPublicationStateKey(null, 'error', '');
  const legacyState = getMapPublicationStateKey(
    null,
    'legacy',
    'https://example.test/zones/current.pmtiles',
  );

  assert.notEqual(failedState, legacyState);
});
