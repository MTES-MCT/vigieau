import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RegleauLogger } from '../logger/regleau.logger';
import { generateEmptyPmtiles } from '../zone_alerte_computed/empty-pmtiles';
import {
  HistoricBackfillArtifactBuilderService,
  HistoricBackfillArtifactYieldError,
} from './historic-backfill-artifact-builder.service';
import {
  assertTippecanoeExecutables,
  collectLegacyHistoricBackfillPmtilesFeatureIds,
  collectPmtilesFeatureIds,
  generatePmtiles,
} from '../zone_alerte_computed/pmtiles-generation';

jest.mock('../zone_alerte_computed/pmtiles-generation', () => ({
  assertTippecanoeExecutables: jest.fn().mockResolvedValue(undefined),
  collectPmtilesFeatureIds: jest.fn((features) =>
    features.map((feature) => String(feature.properties.id)),
  ),
  collectLegacyHistoricBackfillPmtilesFeatureIds: jest.fn((features) => ({
    expectedFeatureIds: features
      .filter((feature) => feature.geometry?.coordinates?.length > 0)
      .map((feature) => String(feature.properties.id)),
    excludedEmptyGeometryIds: features
      .filter((feature) => feature.geometry?.coordinates?.length === 0)
      .map((feature) => String(feature.properties.id)),
  })),
  generatePmtiles: jest.fn(async ({ outputPath }) => {
    await writeFile(outputPath, Buffer.from('PMTiles\x03artifact'));
  }),
}));
jest.mock('../zone_alerte_computed/empty-pmtiles', () => ({
  generateEmptyPmtiles: jest.fn(async ({ outputPath }) => {
    await writeFile(outputPath, Buffer.from('PMTiles\x03empty'));
  }),
}));

describe('HistoricBackfillArtifactBuilderService', () => {
  const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const body = Buffer.from(
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [1, 2] },
          properties: { id: 42 },
        },
      ],
    }),
  );
  const sha = createHash('sha256').update(body).digest('hex');
  const emptyBody = Buffer.from(
    JSON.stringify({ type: 'FeatureCollection', features: [] }),
  );
  const emptySha = createHash('sha256').update(emptyBody).digest('hex');
  const lease = {
    runId,
    validFrom: '2026-08-01',
    validThrough: '2026-08-03',
    workerId: 'artifact-worker',
    leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    leaseExpiresAt: new Date(Date.now() + 60_000),
    attemptCount: 1,
    sourceRevision: '168348',
    historicComputeEpoch: '462',
  };
  const previousCacheMaxBytes =
    process.env.HISTORIC_BACKFILL_ARTIFACT_CACHE_MAX_BYTES;
  const previousDownloadConcurrency =
    process.env.HISTORIC_BACKFILL_ARTIFACT_DOWNLOAD_CONCURRENCY;
  const previousArtifactAcl = process.env.HISTORIC_BACKFILL_ARTIFACT_ACL;
  const temporaryDirectories = new Set<string>();

  const createHarness = async () => {
    const basePath = await mkdtemp(
      join(tmpdir(), 'vigieau-historic-artifacts-'),
    );
    temporaryDirectories.add(basePath);
    const segments = Array.from({ length: 101 }, (_, index) => ({
      departementId: index + 1,
      geojsonObjectKey: `historic/${index + 1}.geojson`,
      geojsonChecksum: index === 0 ? sha : emptySha,
      featureCount: index === 0 ? 1 : 0,
    }));
    const dataSource = {
      manager: {},
      query: jest.fn().mockResolvedValue([
        {
          queued: false,
          snapshotRunning: false,
          dailyRunRunning: false,
        },
      ]),
    };
    const queue = {
      getOutputSegments: jest.fn().mockResolvedValue(segments),
    };
    const s3Service = {
      downloadFile: jest.fn(async (key: string) =>
        key.endsWith('/1.geojson') ? body : emptyBody,
      ),
      uploadFile: jest.fn().mockResolvedValue({}),
    };
    const service = new HistoricBackfillArtifactBuilderService(
      dataSource as any,
      queue as any,
      s3Service as any,
      {
        get: jest.fn((key: string) =>
          key === 'PATH_TO_WRITE_FILE' ? basePath : undefined,
        ),
      } as any,
    );
    return { dataSource, queue, s3Service, service, segments };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(process, 'cwd').mockReturnValue('/workspace/apps/backend-admin');
    delete process.env.HISTORIC_BACKFILL_ARTIFACT_CACHE_MAX_BYTES;
    delete process.env.HISTORIC_BACKFILL_ARTIFACT_DOWNLOAD_CONCURRENCY;
    delete process.env.HISTORIC_BACKFILL_ARTIFACT_ACL;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    try {
      await Promise.all(
        [...temporaryDirectories].map((directory) =>
          rm(directory, { force: true, recursive: true }),
        ),
      );
    } finally {
      temporaryDirectories.clear();
    }
  });

  afterAll(() => {
    if (previousCacheMaxBytes === undefined) {
      delete process.env.HISTORIC_BACKFILL_ARTIFACT_CACHE_MAX_BYTES;
    } else {
      process.env.HISTORIC_BACKFILL_ARTIFACT_CACHE_MAX_BYTES =
        previousCacheMaxBytes;
    }
    if (previousDownloadConcurrency === undefined) {
      delete process.env.HISTORIC_BACKFILL_ARTIFACT_DOWNLOAD_CONCURRENCY;
    } else {
      process.env.HISTORIC_BACKFILL_ARTIFACT_DOWNLOAD_CONCURRENCY =
        previousDownloadConcurrency;
    }
    if (previousArtifactAcl === undefined) {
      delete process.env.HISTORIC_BACKFILL_ARTIFACT_ACL;
    } else {
      process.env.HISTORIC_BACKFILL_ARTIFACT_ACL = previousArtifactAcl;
    }
  });

  it('merges 101 certified department objects and uploads one national pair', async () => {
    const harness = await createHarness();

    const result = await harness.service.build(
      lease,
      new AbortController().signal,
    );

    expect(harness.s3Service.downloadFile).toHaveBeenCalledTimes(101);
    expect(assertTippecanoeExecutables).toHaveBeenCalledWith(
      '/workspace/apps/backend-admin/tippecanoe_program/bin',
      ['tippecanoe', 'tippecanoe-decode', 'tile-join'],
    );
    expect(generatePmtiles).toHaveBeenCalledTimes(1);
    expect(collectPmtilesFeatureIds).toHaveBeenCalledTimes(1);
    expect(
      collectLegacyHistoricBackfillPmtilesFeatureIds,
    ).not.toHaveBeenCalled();
    expect(generatePmtiles).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: expect.stringMatching(/\/historic-backfill-[^/]+$/),
        tippecanoeBinDirectory:
          '/workspace/apps/backend-admin/tippecanoe_program/bin',
      }),
    );
    expect(harness.s3Service.uploadFile).toHaveBeenCalledTimes(2);
    expect(
      harness.s3Service.uploadFile.mock.calls.map(([, , options]) => options),
    ).toEqual([
      {
        abortSignal: expect.any(AbortSignal),
        acl: 'public-read',
      },
      {
        abortSignal: expect.any(AbortSignal),
        acl: 'public-read',
      },
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        geojsonObjectKey: expect.stringMatching(
          new RegExp(
            `^historic-backfill/${runId}/national/` +
              `revision-${lease.sourceRevision}/` +
              `epoch-${lease.historicComputeEpoch}/` +
              `2026-08-01-[0-9a-f]{64}\\.geojson$`,
          ),
        ),
        pmtilesObjectKey: expect.stringMatching(
          new RegExp(
            `^historic-backfill/${runId}/national/` +
              `revision-${lease.sourceRevision}/` +
              `epoch-${lease.historicComputeEpoch}/` +
              `2026-08-01-[0-9a-f]{64}\\.pmtiles$`,
          ),
        ),
        featureCount: 1,
      }),
    );
    expect(result.geojsonChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(result.pmtilesChecksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('retains the certified legacy empty feature but excludes it from PMTiles integrity', async () => {
    const legacyBody = Buffer.from(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'MultiPolygon', coordinates: [] },
            properties: { id: 7626 },
          },
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [1, 2] },
            properties: { id: 42 },
          },
        ],
      }),
    );
    const harness = await createHarness();
    harness.segments[0].geojsonChecksum = createHash('sha256')
      .update(legacyBody)
      .digest('hex');
    harness.segments[0].featureCount = 2;
    harness.s3Service.downloadFile.mockImplementation(async (key: string) =>
      key.endsWith('/1.geojson') ? legacyBody : emptyBody,
    );
    const warning = jest
      .spyOn(RegleauLogger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const result = await harness.service.build(
      { ...lease, validFrom: '2022-06-18', validThrough: '2022-06-18' },
      new AbortController().signal,
    );

    expect(collectPmtilesFeatureIds).not.toHaveBeenCalled();
    expect(collectLegacyHistoricBackfillPmtilesFeatureIds).toHaveBeenCalledWith(
      expect.any(Array),
      [7626],
    );
    expect(generatePmtiles).toHaveBeenCalledWith(
      expect.objectContaining({ expectedFeatureIds: ['42'] }),
    );
    expect(result.featureCount).toBe(2);
    const uploadedGeojson = JSON.parse(
      harness.s3Service.uploadFile.mock.calls[0][0].buffer.toString('utf8'),
    );
    expect(uploadedGeojson.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          geometry: { type: 'MultiPolygon', coordinates: [] },
          properties: expect.objectContaining({ id: 7626 }),
        }),
      ]),
    );
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'historic_backfill_pmtiles_empty_geometries_excluded',
      ),
    );
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('7626'));
  });

  it('generates an empty PMTiles when every legacy feature is allowlisted empty', async () => {
    const emptyLegacyBody = Buffer.from(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'MultiPolygon', coordinates: [] },
            properties: { id: 7626 },
          },
        ],
      }),
    );
    const harness = await createHarness();
    harness.segments[0].geojsonChecksum = createHash('sha256')
      .update(emptyLegacyBody)
      .digest('hex');
    harness.segments[0].featureCount = 1;
    harness.s3Service.downloadFile.mockImplementation(async (key: string) =>
      key.endsWith('/1.geojson') ? emptyLegacyBody : emptyBody,
    );
    jest
      .spyOn(RegleauLogger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const result = await harness.service.build(
      { ...lease, validFrom: '2022-06-18', validThrough: '2022-06-18' },
      new AbortController().signal,
    );

    expect(generateEmptyPmtiles).toHaveBeenCalledTimes(1);
    expect(generatePmtiles).not.toHaveBeenCalled();
    expect(result.featureCount).toBe(1);
  });

  it('fails before reading S3 when the slug Tippecanoe install is incomplete', async () => {
    const harness = await createHarness();
    jest
      .mocked(assertTippecanoeExecutables)
      .mockRejectedValueOnce(new Error('missing tile-join'));

    await expect(
      harness.service.build(lease, new AbortController().signal),
    ).rejects.toThrow('missing tile-join');

    expect(harness.queue.getOutputSegments).not.toHaveBeenCalled();
    expect(harness.s3Service.downloadFile).not.toHaveBeenCalled();
    expect(generatePmtiles).not.toHaveBeenCalled();
    expect(harness.s3Service.uploadFile).not.toHaveBeenCalled();
  });

  it('uploads national staging artifacts with the configured private ACL', async () => {
    process.env.HISTORIC_BACKFILL_ARTIFACT_ACL = 'private';
    const harness = await createHarness();

    await harness.service.build(lease, new AbortController().signal);

    expect(
      harness.s3Service.uploadFile.mock.calls.map(
        ([, , options]) => options.acl,
      ),
    ).toEqual(['private', 'private']);
  });

  it('reuses checksum-certified department buffers across artifact tasks', async () => {
    const harness = await createHarness();

    await harness.service.build(lease, new AbortController().signal);
    await harness.service.build(
      { ...lease, validFrom: '2026-08-02' },
      new AbortController().signal,
    );

    expect(harness.s3Service.downloadFile).toHaveBeenCalledTimes(101);
    expect(harness.s3Service.uploadFile).toHaveBeenCalledTimes(4);
  });

  it('disables reuse when the cache byte limit is zero', async () => {
    process.env.HISTORIC_BACKFILL_ARTIFACT_CACHE_MAX_BYTES = '0';
    const harness = await createHarness();

    await harness.service.build(lease, new AbortController().signal);
    await harness.service.build(
      { ...lease, validFrom: '2026-08-02' },
      new AbortController().signal,
    );

    expect(harness.s3Service.downloadFile).toHaveBeenCalledTimes(202);
  });

  it('rejects a cache byte limit above 1 GiB before downloading', async () => {
    process.env.HISTORIC_BACKFILL_ARTIFACT_CACHE_MAX_BYTES = '1073741825';
    const harness = await createHarness();

    await expect(
      harness.service.build(lease, new AbortController().signal),
    ).rejects.toThrow(
      'HISTORIC_BACKFILL_ARTIFACT_CACHE_MAX_BYTES must be an integer between 0 and 1073741824',
    );
    expect(harness.s3Service.downloadFile).not.toHaveBeenCalled();
  });

  it('evicts least-recently-used buffers deterministically at the byte limit', async () => {
    process.env.HISTORIC_BACKFILL_ARTIFACT_CACHE_MAX_BYTES = String(
      emptyBody.byteLength * 2,
    );
    process.env.HISTORIC_BACKFILL_ARTIFACT_DOWNLOAD_CONCURRENCY = '1';
    const harness = await createHarness();

    await harness.service.build(lease, new AbortController().signal);
    const retainedTail = harness.segments.slice(-2);
    harness.queue.getOutputSegments.mockResolvedValue([
      ...retainedTail,
      ...harness.segments.slice(0, -2),
    ]);
    await harness.service.build(
      { ...lease, validFrom: '2026-08-02' },
      new AbortController().signal,
    );

    const downloadedKeys = harness.s3Service.downloadFile.mock.calls.map(
      ([key]) => key,
    );
    expect(downloadedKeys).toHaveLength(200);
    expect(
      downloadedKeys.filter((key) => key === 'historic/100.geojson'),
    ).toHaveLength(1);
    expect(
      downloadedKeys.filter((key) => key === 'historic/101.geojson'),
    ).toHaveLength(1);
  });

  it('uses both object key and checksum as the cache identity', async () => {
    const harness = await createHarness();
    const replacementBody = Buffer.from(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [3, 4] },
            properties: { id: 84 },
          },
        ],
      }),
    );
    const replacementSha = createHash('sha256')
      .update(replacementBody)
      .digest('hex');

    await harness.service.build(lease, new AbortController().signal);
    harness.segments[0].geojsonChecksum = replacementSha;
    harness.s3Service.downloadFile.mockImplementation(async (key: string) =>
      key.endsWith('/1.geojson') ? replacementBody : emptyBody,
    );
    await harness.service.build(
      { ...lease, validFrom: '2026-08-02' },
      new AbortController().signal,
    );

    expect(harness.s3Service.downloadFile).toHaveBeenCalledTimes(102);
    expect(
      harness.s3Service.downloadFile.mock.calls.filter(
        ([key]) => key === 'historic/1.geojson',
      ),
    ).toHaveLength(2);
  });

  it('never caches a department checksum mismatch', async () => {
    const harness = await createHarness();
    const corruptBody = Buffer.from(body);
    corruptBody[0] ^= 1;
    harness.s3Service.downloadFile.mockImplementation(async (key: string) =>
      key.endsWith('/1.geojson') ? corruptBody : emptyBody,
    );

    await expect(
      harness.service.build(lease, new AbortController().signal),
    ).rejects.toThrow('checksum mismatch');
    expect(generatePmtiles).not.toHaveBeenCalled();
    expect(harness.s3Service.uploadFile).not.toHaveBeenCalled();

    harness.s3Service.downloadFile.mockImplementation(async (key: string) =>
      key.endsWith('/1.geojson') ? body : emptyBody,
    );
    await expect(
      harness.service.build(lease, new AbortController().signal),
    ).resolves.toEqual(expect.objectContaining({ featureCount: 1 }));
    expect(
      harness.s3Service.downloadFile.mock.calls.filter(
        ([key]) => key === 'historic/1.geojson',
      ),
    ).toHaveLength(2);
  });

  it('never caches a download completed after the artifact task aborts', async () => {
    process.env.HISTORIC_BACKFILL_ARTIFACT_DOWNLOAD_CONCURRENCY = '1';
    const harness = await createHarness();
    const controller = new AbortController();
    const abortError = new Error('lease lost');
    harness.s3Service.downloadFile.mockImplementationOnce(async () => {
      controller.abort(abortError);
      return body;
    });

    await expect(harness.service.build(lease, controller.signal)).rejects.toBe(
      abortError,
    );

    harness.s3Service.downloadFile.mockImplementation(async (key: string) =>
      key.endsWith('/1.geojson') ? body : emptyBody,
    );
    await expect(
      harness.service.build(
        { ...lease, validFrom: '2026-08-02' },
        new AbortController().signal,
      ),
    ).resolves.toEqual(expect.objectContaining({ featureCount: 1 }));
    expect(
      harness.s3Service.downloadFile.mock.calls.filter(
        ([key]) => key === 'historic/1.geojson',
      ),
    ).toHaveLength(2);
  });

  it('yields before reading artifacts when a current computation is pending', async () => {
    const harness = await createHarness();
    harness.dataSource.query.mockResolvedValueOnce([
      { queued: true, snapshotRunning: false, dailyRunRunning: false },
    ]);

    await expect(
      harness.service.build(lease, new AbortController().signal),
    ).rejects.toBeInstanceOf(HistoricBackfillArtifactYieldError);
    expect(harness.s3Service.downloadFile).not.toHaveBeenCalled();
  });

  it('yields before reading artifacts when the national daily run is active', async () => {
    const harness = await createHarness();
    harness.dataSource.query.mockResolvedValueOnce([
      {
        queued: false,
        snapshotRunning: false,
        dailyRunRunning: true,
      },
    ]);

    await expect(
      harness.service.build(lease, new AbortController().signal),
    ).rejects.toBeInstanceOf(HistoricBackfillArtifactYieldError);
    expect(harness.s3Service.downloadFile).not.toHaveBeenCalled();
    expect(harness.dataSource.query.mock.calls[0][0]).toContain(
      'FROM "external_publication_run" daily_run',
    );
  });
});
