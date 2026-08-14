import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canRetainDisplayedZoneSource,
  captureDisplayedZonePublicationPin,
  getPmtilesRequestKind,
  getZoneSourceKey,
  getZoneSourceLoadAction,
  isEmptyPmtilesArchive,
  selectResponsivePublicationPin,
  shouldResetZoneSourceRetryCycle,
} from '../client/utils/zone-source-transition.ts';

const getAction = (overrides = {}) =>
  getZoneSourceLoadAction({
    failed: false,
    requestKind: 'tilejson',
    isPendingCandidate: true,
    candidateValidated: false,
    retryCount: 0,
    retryLimit: 2,
    ...overrides,
  });

test('distinguishes TileJSON metadata from actual tile requests', () => {
  assert.equal(getPmtilesRequestKind('json'), 'tilejson');
  assert.equal(getPmtilesRequestKind('arrayBuffer'), 'tile');
  assert.equal(getAction(), 'ignore');
  assert.equal(getAction({ requestKind: 'tile' }), 'validate');
});

test('recognizes a PMTiles archive that has no tile data to validate', () => {
  assert.equal(
    isEmptyPmtilesArchive({
      numAddressedTiles: 0,
      numTileEntries: 0,
      numTileContents: 0,
    }),
    true,
  );
  assert.equal(
    isEmptyPmtilesArchive({
      numAddressedTiles: 1,
      numTileEntries: 1,
      numTileContents: 1,
    }),
    false,
  );
});

test('restores an unvalidated candidate and retries within the bound', () => {
  assert.equal(
    getAction({ failed: true, requestKind: 'tile', retryCount: 0 }),
    'restore-and-retry',
  );
  assert.equal(
    getAction({ failed: true, requestKind: 'tilejson', retryCount: 1 }),
    'restore-and-retry',
  );
  assert.equal(
    getAction({ failed: true, requestKind: 'tile', retryCount: 2 }),
    'restore',
  );
});

test('never removes a source that has already been validated', () => {
  assert.equal(
    getAction({
      failed: true,
      requestKind: 'tile',
      candidateValidated: true,
    }),
    'keep',
  );
  assert.equal(
    getAction({
      failed: true,
      requestKind: 'tile',
      isPendingCandidate: false,
    }),
    'keep',
  );
});

test('source identity includes the publication pin', () => {
  const url = 'https://example.test/zones/current.pmtiles';

  assert.notEqual(
    getZoneSourceKey(url, 'publication-a'),
    getZoneSourceKey(url, 'publication-b'),
  );
  assert.notEqual(
    getZoneSourceKey(url, 'publication-a'),
    getZoneSourceKey(url, null),
  );
});

test('retains a fallback only for the same semantic map view', () => {
  assert.equal(canRetainDisplayedZoneSource('current', 'current'), true);
  assert.equal(
    canRetainDisplayedZoneSource('historic:2026-07-30', 'historic:2026-07-30'),
    true,
  );
  assert.equal(
    canRetainDisplayedZoneSource('current', 'historic:2026-07-30'),
    false,
  );
  assert.equal(
    canRetainDisplayedZoneSource('historic:2026-07-29', 'historic:2026-07-30'),
    false,
  );
  assert.equal(canRetainDisplayedZoneSource(null, 'current'), false);
});

test('selects the publication pin from the responsive map that is visible', () => {
  const desktopPin = { publicationId: 'desktop-publication' };
  const mobilePin = { publicationId: 'mobile-publication' };

  assert.equal(
    selectResponsivePublicationPin(true, desktopPin, mobilePin),
    desktopPin,
  );
  assert.equal(
    selectResponsivePublicationPin(false, desktopPin, mobilePin),
    mobilePin,
  );
  assert.equal(selectResponsivePublicationPin(true, null, mobilePin), null);
});

test('opens one new retry cycle after a successful forced refresh', () => {
  assert.equal(shouldResetZoneSourceRetryCycle(3, 3), false);
  assert.equal(shouldResetZoneSourceRetryCycle(3, 4), true);
});

test('popup pin captures the publication displayed when it is bound', () => {
  let displayedPublicationId = 'publication-a';
  const capturedPin = captureDisplayedZonePublicationPin(
    displayedPublicationId,
  );

  displayedPublicationId = 'publication-b';
  assert.deepEqual(capturedPin, { publicationId: 'publication-a' });
  assert.deepEqual(captureDisplayedZonePublicationPin(null), {
    publicationId: null,
  });
  assert.equal(displayedPublicationId, 'publication-b');
});
