import { ZonePublicationPromotionService } from './zone_publication_promotion.service';

function activePublication() {
  return {
    id: 'publication-1',
    sourceComputedAt: new Date('2026-07-31T12:00:00Z'),
    geojsonUrl:
      'https://objects.example.test/geojson/zones_arretes_en_vigueur_immutable.geojson',
    geojsonChecksum: 'a'.repeat(64),
    pmtilesUrl:
      'https://objects.example.test/pmtiles/zones_arretes_en_vigueur_immutable.pmtiles',
    pmtilesChecksum: 'b'.repeat(64),
  };
}

function createHarness(options?: {
  lock?: boolean;
  stableLock?: boolean;
  dataGouvLock?: boolean;
  publication?: object | null;
  stableCompletion?: boolean;
  dataGouvCompletion?: boolean;
  activePublication?: boolean;
}) {
  const publication =
    options && 'publication' in options
      ? options.publication
      : activePublication();
  const manager = {
    query: jest.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes('pg_try_advisory_xact_lock')) {
        const lockName = parameters?.[0];
        return [
          {
            locked:
              lockName === 'vigieau:zone-publication-datagouv-promotion'
                ? (options?.dataGouvLock ?? options?.lock ?? true)
                : (options?.stableLock ?? options?.lock ?? true),
          },
        ];
      }
      if (sql.includes('SELECT state."activePublicationId"')) {
        return options?.activePublication === false
          ? []
          : [{ activePublicationId: activePublication().id }];
      }
      if (sql.includes('SELECT publication."id"')) {
        return publication ? [publication] : [];
      }
      if (sql.includes('UPDATE "config"')) {
        const sourceComputedAt =
          publication && 'sourceComputedAt' in publication
            ? publication.sourceComputedAt
            : activePublication().sourceComputedAt;
        return [
          [
            {
              computeZoneAlerteComputedDate: new Date(
                sourceComputedAt as Date | string,
              ),
            },
          ],
          1,
        ];
      }
      if (sql.includes('RETURNING publication."id"')) {
        if (sql.includes('"dataGouvPromotedAt" = now()')) {
          return options?.dataGouvCompletion === false
            ? [[], 0]
            : [[{ id: activePublication().id }], 1];
        }
        return options?.stableCompletion === false
          ? [[], 0]
          : [[{ id: activePublication().id }], 1];
      }
      return [];
    }),
  };
  let transactionRollbackCount = 0;
  const dataSource = {
    transaction: jest.fn(async (callback) => {
      try {
        return await callback(manager);
      } catch (error) {
        transactionRollbackCount += 1;
        throw error;
      }
    }),
    query: jest.fn().mockResolvedValue([[{ id: activePublication().id }], 1]),
  };
  const s3Service = {
    copyFile: jest.fn().mockResolvedValue(undefined),
    headFile: jest.fn(
      (fileName: string, prefix?: string, options?: unknown) => {
        void prefix;
        void options;
        return Promise.resolve({
          ContentLength: 100,
          ContentType: fileName.endsWith('.geojson')
            ? 'application/geo+json'
            : 'application/vnd.pmtiles',
          CacheControl: fileName.match(
            /zones_arretes_en_vigueur_(?:[a-f0-9]{64})\./,
          )
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=0, must-revalidate',
        });
      },
    ),
    getPublicFileUrl: jest.fn((fileName: string, prefix: string) => {
      return `https://objects.example.test/${prefix}${fileName}`;
    }),
  };
  const datagouvService = {
    canUploadToDataGouv: jest.fn().mockReturnValue(true),
    uploadToDatagouv: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ZonePublicationPromotionService(
    dataSource as any,
    s3Service as any,
    datagouvService as any,
  );

  return {
    dataSource,
    datagouvService,
    getTransactionRollbackCount: () => transactionRollbackCount,
    manager,
    s3Service,
    service,
  };
}

describe('ZonePublicationPromotionService', () => {
  const previousEnabled = process.env.ZONE_PUBLICATION_ENABLED;
  const previousRetry = process.env.ZONE_PUBLICATION_PROMOTION_RETRY_SECONDS;
  const previousTimeout = process.env.ZONE_PUBLICATION_DATAGOUV_TIMEOUT_MS;
  const previousS3Timeout = process.env.ZONE_PUBLICATION_S3_TIMEOUT_MS;

  beforeEach(() => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    delete process.env.ZONE_PUBLICATION_PROMOTION_RETRY_SECONDS;
    delete process.env.ZONE_PUBLICATION_DATAGOUV_TIMEOUT_MS;
    delete process.env.ZONE_PUBLICATION_S3_TIMEOUT_MS;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (previousEnabled === undefined) {
      delete process.env.ZONE_PUBLICATION_ENABLED;
    } else {
      process.env.ZONE_PUBLICATION_ENABLED = previousEnabled;
    }
    if (previousRetry === undefined) {
      delete process.env.ZONE_PUBLICATION_PROMOTION_RETRY_SECONDS;
    } else {
      process.env.ZONE_PUBLICATION_PROMOTION_RETRY_SECONDS = previousRetry;
    }
    if (previousTimeout === undefined) {
      delete process.env.ZONE_PUBLICATION_DATAGOUV_TIMEOUT_MS;
    } else {
      process.env.ZONE_PUBLICATION_DATAGOUV_TIMEOUT_MS = previousTimeout;
    }
    if (previousS3Timeout === undefined) {
      delete process.env.ZONE_PUBLICATION_S3_TIMEOUT_MS;
    } else {
      process.env.ZONE_PUBLICATION_S3_TIMEOUT_MS = previousS3Timeout;
    }
  });

  it('keeps every external promotion disabled with the feature flag', async () => {
    delete process.env.ZONE_PUBLICATION_ENABLED;
    const harness = createHarness();

    await expect(harness.service.promoteStableArtifacts()).resolves.toBe(
      'disabled',
    );
    await expect(harness.service.promoteDataGouv()).resolves.toBe('disabled');
    expect(harness.dataSource.transaction).not.toHaveBeenCalled();
    expect(harness.s3Service.copyFile).not.toHaveBeenCalled();
    expect(harness.datagouvService.uploadToDatagouv).not.toHaveBeenCalled();
    expect(harness.getTransactionRollbackCount()).toBe(0);
  });

  it('serializes stable promotion with activation and switches PMTiles last', async () => {
    process.env.ZONE_PUBLICATION_S3_TIMEOUT_MS = '42500';
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const harness = createHarness();

    await expect(harness.service.promoteStableArtifacts()).resolves.toBe(
      'promoted',
    );

    expect(harness.manager.query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
      ['vigieau:zone-publication-stable-promotion'],
    );
    expect(timeout).toHaveBeenCalledTimes(4);
    expect(timeout).toHaveBeenCalledWith(42_500);
    expect(harness.s3Service.copyFile.mock.calls).toEqual([
      [
        `zones_arretes_en_vigueur_${'a'.repeat(64)}.geojson`,
        'zones_arretes_en_vigueur_2026-07-31.geojson',
        'geojson/',
        {
          abortSignal: expect.any(AbortSignal),
          cacheControl: 'public, max-age=0, must-revalidate',
          contentType: 'application/geo+json',
        },
      ],
      [
        `zones_arretes_en_vigueur_${'b'.repeat(64)}.pmtiles`,
        'zones_arretes_en_vigueur_2026-07-31.pmtiles',
        'pmtiles/',
        {
          abortSignal: expect.any(AbortSignal),
          cacheControl: 'public, max-age=0, must-revalidate',
          contentType: 'application/vnd.pmtiles',
        },
      ],
      [
        `zones_arretes_en_vigueur_${'a'.repeat(64)}.geojson`,
        'zones_arretes_en_vigueur.geojson',
        'geojson/',
        {
          abortSignal: expect.any(AbortSignal),
          cacheControl: 'public, max-age=0, must-revalidate',
          contentType: 'application/geo+json',
        },
      ],
      [
        `zones_arretes_en_vigueur_${'b'.repeat(64)}.pmtiles`,
        'zones_arretes_en_vigueur.pmtiles',
        'pmtiles/',
        {
          abortSignal: expect.any(AbortSignal),
          cacheControl: 'public, max-age=0, must-revalidate',
          contentType: 'application/vnd.pmtiles',
        },
      ],
    ]);
    const copySignals = harness.s3Service.copyFile.mock.calls.map(
      ([, , , options]) => options.abortSignal,
    );
    expect(new Set(copySignals).size).toBe(4);
    expect(harness.s3Service.headFile).toHaveBeenCalledTimes(8);
    copySignals.forEach((copySignal, index) => {
      expect(harness.s3Service.headFile.mock.calls[index * 2][2]).toEqual({
        abortSignal: copySignal,
      });
      expect(harness.s3Service.headFile.mock.calls[index * 2 + 1][2]).toEqual({
        abortSignal: copySignal,
      });
    });
    const configUpdateIndex = harness.manager.query.mock.calls.findIndex(
      ([sql]) => sql.includes('UPDATE "config"'),
    );
    expect(configUpdateIndex).toBeGreaterThan(-1);
    expect(harness.manager.query.mock.calls[configUpdateIndex][1]).toEqual([
      new Date('2026-07-31T12:00:00Z'),
    ]);
    expect(
      harness.manager.query.mock.calls[configUpdateIndex][0],
    ).not.toContain('"computeZoneAlerteComputedDate" < $1');
    expect(harness.s3Service.copyFile.mock.invocationCallOrder[3]).toBeLessThan(
      harness.manager.query.mock.invocationCallOrder[configUpdateIndex],
    );
    const completionIndex = harness.manager.query.mock.calls.findIndex(
      ([sql]) => sql.includes('"legacyPromotedAt" = now()'),
    );
    const completionSql = harness.manager.query.mock.calls[completionIndex][0];
    expect(completionSql).toContain(
      'state."activePublicationId" = publication."id"',
    );
    expect(
      harness.manager.query.mock.invocationCallOrder[configUpdateIndex],
    ).toBeLessThan(
      harness.manager.query.mock.invocationCallOrder[completionIndex],
    );
    expect(harness.datagouvService.uploadToDatagouv).not.toHaveBeenCalled();
  });

  it('retries all stable copies after a partial S3 failure', async () => {
    const harness = createHarness();
    harness.s3Service.copyFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('copy failed'));

    await expect(harness.service.promoteStableArtifacts()).resolves.toBe(
      'failed',
    );
    expect(harness.s3Service.copyFile).toHaveBeenCalledTimes(2);
    expect(
      harness.manager.query.mock.calls.some(([sql]) =>
        sql.includes('UPDATE "config"'),
      ),
    ).toBe(false);
    expect(harness.dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('"promotionLastAttemptAt" = now()'),
      ['publication-1', 'copy failed'],
    );
    expect(harness.getTransactionRollbackCount()).toBe(1);
    expect(
      harness.manager.query.mock.calls.some(([sql]) =>
        sql.includes('SET "promotionError" = $2'),
      ),
    ).toBe(false);

    harness.s3Service.copyFile.mockResolvedValue(undefined);
    await expect(harness.service.promoteStableArtifacts()).resolves.toBe(
      'promoted',
    );
    expect(harness.s3Service.copyFile).toHaveBeenCalledTimes(6);
    expect(
      harness.manager.query.mock.calls.filter(([sql]) =>
        sql.includes('UPDATE "config"'),
      ),
    ).toHaveLength(1);
  });

  it('synchronizes the legacy computation date exactly during a rollback', async () => {
    const rollbackPublication = {
      ...activePublication(),
      id: 'rollback-publication',
      sourceComputedAt: new Date('2026-07-29T08:00:00Z'),
    };
    const harness = createHarness({ publication: rollbackPublication });

    await expect(harness.service.promoteStableArtifacts()).resolves.toBe(
      'promoted',
    );

    const configUpdate = harness.manager.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE "config"'),
    );
    expect(configUpdate?.[1]).toEqual([new Date('2026-07-29T08:00:00Z')]);
    expect(configUpdate?.[0]).not.toContain(
      '"computeZoneAlerteComputedDate" < $1',
    );
  });

  it('fails the transaction when config and the stable marker cannot commit together', async () => {
    const harness = createHarness({ stableCompletion: false });

    await expect(harness.service.promoteStableArtifacts()).resolves.toBe(
      'failed',
    );

    expect(harness.s3Service.copyFile).toHaveBeenCalledTimes(4);
    expect(harness.dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('"promotionLastAttemptAt" = now()'),
      ['publication-1', 'Zone publication publication-1 is no longer active'],
    );
    expect(harness.getTransactionRollbackCount()).toBe(1);
    expect(
      harness.manager.query.mock.calls.some(([sql]) =>
        sql.includes('SET "promotionError" = $2'),
      ),
    ).toBe(false);
  });

  it('does nothing when another process owns the stable promotion lock', async () => {
    const harness = createHarness({ lock: false });

    await expect(harness.service.promoteStableArtifacts()).resolves.toBe(
      'busy',
    );
    expect(harness.s3Service.copyFile).not.toHaveBeenCalled();
    expect(
      harness.manager.query.mock.calls.some(([sql]) =>
        sql.includes('UPDATE "config"'),
      ),
    ).toBe(false);
  });

  it('publishes data.gouv only for an active publication already promoted to stable', async () => {
    process.env.ZONE_PUBLICATION_DATAGOUV_TIMEOUT_MS = '12500';
    const harness = createHarness();

    await expect(harness.service.promoteDataGouv()).resolves.toBe('promoted');

    const selectionSql = harness.manager.query.mock.calls.find(([sql]) =>
      sql.includes('SELECT publication."id"'),
    )?.[0];
    expect(selectionSql).toContain(
      'publication."legacyPromotedAt" IS NOT NULL',
    );
    expect(selectionSql).toContain('publication."dataGouvPromotedAt" IS NULL');
    expect(harness.datagouvService.uploadToDatagouv.mock.calls).toEqual([
      [
        'geojson',
        'https://objects.example.test/geojson/zones_arretes_en_vigueur_immutable.geojson',
        'Carte des zones et arrêtés en vigueur - GeoJSON',
        true,
        { timeoutMs: 12_500 },
      ],
      [
        'pmtiles',
        'https://objects.example.test/pmtiles/zones_arretes_en_vigueur_immutable.pmtiles',
        'Carte des zones et arrêtés en vigueur - PMTILES',
        true,
        { timeoutMs: 12_500 },
      ],
    ]);
    const completionSql = harness.manager.query.mock.calls.find(([sql]) =>
      sql.includes('"dataGouvPromotedAt" = now()'),
    )?.[0];
    expect(completionSql).toContain('"dataGouvPromotedAt" = now()');
    expect(completionSql).toContain(
      'state."activePublicationId" = publication."id"',
    );
    expect(harness.s3Service.copyFile).not.toHaveBeenCalled();
    expect(selectionSql).toContain('publication."geojsonUrl"');
    expect(selectionSql).toContain('publication."pmtilesUrl"');
    expect(harness.manager.query.mock.calls.slice(0, 2)).toEqual([
      [
        'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
        ['vigieau:zone-publication-stable-promotion'],
      ],
      [
        'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
        ['vigieau:zone-publication-datagouv-promotion'],
      ],
    ]);
    expect(harness.getTransactionRollbackCount()).toBe(0);
  });

  it('does not write data.gouv while activation or another promotion owns a lock', async () => {
    const activationHarness = createHarness({ stableLock: false });
    const promotionHarness = createHarness({ dataGouvLock: false });

    await expect(activationHarness.service.promoteDataGouv()).resolves.toBe(
      'busy',
    );
    await expect(promotionHarness.service.promoteDataGouv()).resolves.toBe(
      'busy',
    );

    expect(
      activationHarness.datagouvService.uploadToDatagouv,
    ).not.toHaveBeenCalled();
    expect(
      promotionHarness.datagouvService.uploadToDatagouv,
    ).not.toHaveBeenCalled();
  });

  it('checks that the pinned publication is still active before external writes', async () => {
    const harness = createHarness({ activePublication: false });

    await expect(harness.service.promoteDataGouv()).resolves.toBe('failed');

    expect(harness.datagouvService.uploadToDatagouv).not.toHaveBeenCalled();
    expect(harness.getTransactionRollbackCount()).toBe(1);
    expect(harness.dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('SET "promotionLastAttemptAt" = now()'),
      ['publication-1', 'Zone publication publication-1 is no longer active'],
    );
  });

  it('keeps data.gouv failure retryable without repeating stable copies', async () => {
    const harness = createHarness();
    harness.datagouvService.uploadToDatagouv
      .mockRejectedValueOnce(new Error('data.gouv unavailable'))
      .mockResolvedValue(undefined);

    await expect(harness.service.promoteDataGouv()).resolves.toBe('failed');
    expect(harness.datagouvService.uploadToDatagouv).toHaveBeenCalledTimes(1);
    expect(harness.dataSource.query.mock.calls[0][0]).toContain(
      '"promotionError" = $2',
    );
    expect(harness.dataSource.query.mock.calls[0][1]).toEqual([
      'publication-1',
      'data.gouv unavailable',
    ]);
    expect(harness.s3Service.copyFile).not.toHaveBeenCalled();

    await expect(harness.service.promoteDataGouv()).resolves.toBe('promoted');
    expect(harness.datagouvService.uploadToDatagouv).toHaveBeenCalledTimes(3);
    expect(harness.s3Service.copyFile).not.toHaveBeenCalled();
  });

  it('does not call data.gouv when no stable active publication is eligible', async () => {
    const harness = createHarness({ publication: null });

    await expect(harness.service.promoteDataGouv()).resolves.toBe(
      'nothing_to_do',
    );
    expect(harness.datagouvService.uploadToDatagouv).not.toHaveBeenCalled();
  });

  it('disables data.gouv promotion before taking locks when upload is not configured', async () => {
    const harness = createHarness();
    harness.datagouvService.canUploadToDataGouv.mockReturnValue(false);

    await expect(harness.service.promoteDataGouv()).resolves.toBe('disabled');
    expect(harness.dataSource.transaction).not.toHaveBeenCalled();
    expect(harness.manager.query).not.toHaveBeenCalled();
    expect(harness.dataSource.query).not.toHaveBeenCalled();
    expect(harness.datagouvService.uploadToDatagouv).not.toHaveBeenCalled();
    expect(harness.getTransactionRollbackCount()).toBe(0);
  });
});
