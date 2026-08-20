import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveHistoricMapManifestUrl,
  loadHistoricMapManifest,
  parseHistoricMapManifest,
  resolveHistoricMapPmtilesUrl,
  resolveHistoricMapSourceUrl,
} from '../client/utils/historic-map-manifest.ts';

const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const manifest = {
  version: 1,
  runId,
  mapDateFrom: '2026-08-01',
  dateThrough: '2026-08-03',
  sourceRevision: '42',
  historicComputeEpoch: '9',
  artifacts: [
    {
      validFrom: '2026-08-01',
      validThrough: '2026-08-02',
      geojsonUrl:
        `https://objects.example.test/historic-backfill/${runId}/national/` +
        `revision-42/epoch-9/2026-08-01-${'a'.repeat(64)}.geojson`,
      geojsonChecksum: 'a'.repeat(64),
      pmtilesUrl:
        `https://objects.example.test/historic-backfill/${runId}/national/` +
        `revision-42/epoch-9/2026-08-01-${'b'.repeat(64)}.pmtiles`,
      pmtilesChecksum: 'b'.repeat(64),
      featureCount: 12,
    },
    {
      validFrom: '2026-08-03',
      validThrough: '2026-08-03',
      geojsonUrl:
        `https://objects.example.test/historic-backfill/${runId}/national/` +
        `revision-42/epoch-9/2026-08-03-${'c'.repeat(64)}.geojson`,
      geojsonChecksum: 'c'.repeat(64),
      pmtilesUrl:
        `https://objects.example.test/historic-backfill/${runId}/national/` +
        `revision-42/epoch-9/2026-08-03-${'d'.repeat(64)}.pmtiles`,
      pmtilesChecksum: 'd'.repeat(64),
      featureCount: 14,
    },
  ],
};

test('derives the manifest next to the configured current PMTiles object', () => {
  assert.equal(
    deriveHistoricMapManifestUrl(
      'https://objects.example.test/prod/pmtiles/zones.pmtiles?cache=1',
    ),
    'https://objects.example.test/prod/pmtiles/historic-backfill-manifest.json',
  );
});

test('resolves every day in an immutable artifact interval', () => {
  const parsed = parseHistoricMapManifest(manifest);
  assert.equal(
    resolveHistoricMapPmtilesUrl(parsed, '2026-08-02'),
    manifest.artifacts[0].pmtilesUrl,
  );
  assert.equal(resolveHistoricMapPmtilesUrl(parsed, '2026-07-31'), null);
});

test('uses legacy dated aliases when the manifest is absent or out of range', () => {
  const legacyBase = 'https://objects.example.test/pmtiles/zones';
  assert.equal(
    resolveHistoricMapSourceUrl(null, '2026-08-02', legacyBase, {
      sourceRevision: '42',
      historicComputeEpoch: '9',
    }),
    `${legacyBase}_2026-08-02.pmtiles`,
  );
  assert.equal(
    resolveHistoricMapSourceUrl(undefined, '2026-08-02', legacyBase, {
      sourceRevision: '42',
      historicComputeEpoch: '9',
    }),
    null,
  );
  assert.equal(
    resolveHistoricMapSourceUrl(
      parseHistoricMapManifest(manifest),
      '2026-07-31',
      legacyBase,
      { sourceRevision: '42', historicComputeEpoch: '9' },
    ),
    `${legacyBase}_2026-07-31.pmtiles`,
  );
});

test('keeps the manifest on a source bump and rejects an epoch bump', () => {
  const legacyBase = 'https://objects.example.test/pmtiles/zones';
  const parsed = parseHistoricMapManifest(manifest);

  assert.equal(
    resolveHistoricMapSourceUrl(parsed, '2026-08-02', legacyBase, {
      sourceRevision: '42',
      historicComputeEpoch: '9',
    }),
    manifest.artifacts[0].pmtilesUrl,
  );
  assert.equal(
    resolveHistoricMapSourceUrl(parsed, '2026-08-02', legacyBase, {
      sourceRevision: '43',
      historicComputeEpoch: '9',
    }),
    manifest.artifacts[0].pmtilesUrl,
  );
  assert.equal(
    resolveHistoricMapSourceUrl(parsed, '2026-08-02', legacyBase, {
      sourceRevision: '43',
      historicComputeEpoch: '10',
    }),
    `${legacyBase}_2026-08-02.pmtiles`,
  );
  assert.equal(
    resolveHistoricMapSourceUrl(parsed, '2026-08-02', legacyBase, {
      sourceRevision: '43',
    }),
    `${legacyBase}_2026-08-02.pmtiles`,
  );
});

test('treats only a 404 as the pre-backfill legacy state', async () => {
  const missingFetch = async () => new Response(null, { status: 404 });
  await assert.doesNotReject(async () => {
    assert.equal(
      await loadHistoricMapManifest(
        'https://objects.example.test/manifest.json',
        missingFetch,
      ),
      null,
    );
  });

  const unavailableFetch = async () => new Response(null, { status: 503 });
  await assert.rejects(
    loadHistoricMapManifest(
      'https://objects.example.test/manifest.json',
      unavailableFetch,
    ),
    /failed with 503/,
  );
});

test('rejects gaps and mutable legacy URLs in a published manifest', () => {
  assert.throws(
    () =>
      parseHistoricMapManifest({
        ...manifest,
        artifacts: [
          manifest.artifacts[0],
          {
            ...manifest.artifacts[1],
            validFrom: '2026-08-04',
            pmtilesUrl:
              'https://objects.example.test/pmtiles/zones_2026-08-04.pmtiles',
          },
        ],
      }),
    /artifact 1 is invalid/,
  );
});
