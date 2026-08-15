import { createHash } from 'node:crypto';
import { StatisticCacheArtifactService } from './statistic-cache-artifact.service';

describe('StatisticCacheArtifactService', () => {
  const previousArtifactRequired =
    process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED;
  const publicationId = '00000000-0000-4000-8000-000000000001';
  const previousPublicationId = '00000000-0000-4000-8000-000000000002';
  const fingerprint = 'f'.repeat(64);
  const candidate = {
    statisticRevision: '12',
    currentPublishedDate: '2026-08-15',
    mode: 'legacy-bootstrap' as const,
    materializationStrategy: 'legacy-safe-boundary' as const,
    historicDirtyFrom: '2015-01-01',
    historicDirtyThrough: '2026-08-14',
    historicMapCursor: '2015-01-01',
    historicStatsCursor: '2015-01-01',
    sourceRevision: '42',
    historicComputeEpoch: '7',
    contentFingerprint: fingerprint,
    firstDate: '2026-08-15',
    latestDate: '2026-08-15',
    dateCount: 1,
    departmentCount: 101,
    communeCount: 1,
    dataArea: [{ date: '2026-08-15', ESO: {}, ESU: {}, AEP: {} }],
    dataDepartement: [{ date: '2026-08-15', departements: [] }],
    dataCommune: [{ code: '01001', restrictions: [{ d: '2026-08', p: 2 }] }],
    latestCommuneWeights: [['01001', 2] as [string, number]],
  };

  const createService = () => {
    const dataSource = {
      query: jest.fn(),
      createQueryRunner: jest.fn(),
    };
    return {
      service: new StatisticCacheArtifactService(dataSource as never),
      dataSource,
    };
  };

  afterEach(() => {
    if (previousArtifactRequired === undefined) {
      delete process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED;
    } else {
      process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED = previousArtifactRequired;
    }
  });

  const createRows = (service: StatisticCacheArtifactService) => {
    const artifacts = (service as any).encodeArtifacts(candidate) as Array<{
      kind: string;
      rowCount: number;
      contentFingerprint: string;
      checksum: string;
      compressedByteLength: number;
      uncompressedByteLength: number;
      payload: Buffer;
    }>;
    const compressed = artifacts.reduce(
      (sum, artifact) => sum + artifact.compressedByteLength,
      0,
    );
    const uncompressed = artifacts.reduce(
      (sum, artifact) => sum + artifact.uncompressedByteLength,
      0,
    );
    return artifacts.map((artifact) => ({
      id: publicationId,
      statisticRevision: candidate.statisticRevision,
      currentPublishedDate: candidate.currentPublishedDate,
      schemaVersion: 1,
      mode: candidate.mode,
      materializationStrategy: candidate.materializationStrategy,
      historicDirtyFrom: candidate.historicDirtyFrom,
      historicDirtyThrough: candidate.historicDirtyThrough,
      historicMapCursor: candidate.historicMapCursor,
      historicStatsCursor: candidate.historicStatsCursor,
      sourceRevision: candidate.sourceRevision,
      historicComputeEpoch: candidate.historicComputeEpoch,
      contentFingerprint: candidate.contentFingerprint,
      firstDate: candidate.firstDate,
      latestDate: candidate.latestDate,
      dateCount: candidate.dateCount,
      areaCount: candidate.dataArea.length,
      departmentCount: candidate.departmentCount,
      communeCount: candidate.communeCount,
      publicationCompressedByteLength: compressed,
      publicationUncompressedByteLength: uncompressed,
      readyAt: new Date('2026-08-15T06:00:00.000Z'),
      kind: artifact.kind,
      rowCount: artifact.rowCount,
      artifactContentFingerprint: artifact.contentFingerprint,
      checksum: artifact.checksum,
      compressedByteLength: artifact.compressedByteLength,
      uncompressedByteLength: artifact.uncompressedByteLength,
      payload: artifact.payload,
    }));
  };

  it('loads and verifies the immutable three-artifact envelope', async () => {
    const { service, dataSource } = createService();
    dataSource.query.mockResolvedValue(createRows(service));

    await expect(service.loadActive()).resolves.toMatchObject({
      identity: {
        id: publicationId,
        statisticRevision: '12',
        currentPublishedDate: '2026-08-15',
        contentFingerprint: fingerprint,
      },
      dataCommune: candidate.dataCommune,
      latestCommuneWeights: candidate.latestCommuneWeights,
    });
  });

  it.each([
    [
      'checksum corruption',
      (rows: any[]) => {
        rows[0].checksum = '0'.repeat(64);
      },
      'is invalid',
    ],
    [
      'gzip corruption',
      (rows: any[]) => {
        rows[0].payload = Buffer.from(rows[0].payload);
        rows[0].payload[0] ^= 0xff;
        rows[0].checksum = createHash('sha256')
          .update(rows[0].payload)
          .digest('hex');
      },
      undefined,
    ],
    [
      'zip-bomb size metadata',
      (rows: any[]) => {
        rows[0].uncompressedByteLength = 512 * 1024 * 1024 + 1;
      },
      'sizes are invalid',
    ],
    [
      'row-count corruption',
      (rows: any[]) => {
        rows[0].rowCount += 1;
      },
      'invalid envelope',
    ],
  ])('rejects %s', async (_label, corrupt, message) => {
    const { service, dataSource } = createService();
    const rows = createRows(service);
    corrupt(rows);
    dataSource.query.mockResolvedValue(rows);

    const load = service.loadActive();
    if (message) {
      await expect(load).rejects.toThrow(message);
    } else {
      await expect(load).rejects.toThrow();
    }
  });

  it('rejects an oversized total before decompressing any artifact', async () => {
    const { service, dataSource } = createService();
    const rows = createRows(service);
    for (const row of rows) {
      row.uncompressedByteLength = 200 * 1024 * 1024;
      row.publicationUncompressedByteLength = 600 * 1024 * 1024;
    }
    dataSource.query.mockResolvedValue(rows);

    await expect(service.loadActive()).rejects.toThrow(
      'publication sizes are invalid',
    );
  });

  it('persists in lifecycle order and purges retired publications outside active/previous', async () => {
    const { service } = createService();
    const statements: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('AS "invalidSnapshotCount"')) {
          return [
            {
              revision: '12',
              currentPublishedDate: '2026-08-15',
              historicDirtyFrom: candidate.historicDirtyFrom,
              historicDirtyThrough: candidate.historicDirtyThrough,
              historicMapCursor: candidate.historicMapCursor,
              historicStatsCursor: candidate.historicStatsCursor,
              sourceRevision: '42',
              historicComputeEpoch: '7',
              legacyBoundaryEligible: true,
              pendingCurrentQueueCount: 0,
              invalidSnapshotCount: 0,
            },
          ];
        }
        if (sql.includes('SELECT "activePublicationId"')) {
          return [{ activePublicationId: previousPublicationId }];
        }
        return [];
      }),
    };
    const artifacts = (service as any).encodeArtifacts(candidate);

    await (service as any).persistPublication(
      manager,
      publicationId,
      candidate,
      artifacts,
    );

    const index = (fragment: string) =>
      statements.findIndex((sql) => sql.includes(fragment));
    expect(index('INSERT INTO "statistic_cache_publication"')).toBeLessThan(
      index('INSERT INTO "statistic_cache_artifact"'),
    );
    expect(index('INSERT INTO "statistic_cache_artifact"')).toBeLessThan(
      index(`SET "status" = 'ready'`),
    );
    expect(index(`SET "status" = 'ready'`)).toBeLessThan(
      index(`SET "status" = 'retired'`),
    );
    expect(index(`SET "status" = 'retired'`)).toBeLessThan(
      index(`SET "status" = 'active'`),
    );
    expect(index('UPDATE "statistic_cache_state"')).toBeLessThan(
      index('DELETE FROM "statistic_cache_publication" publication'),
    );
    expect(manager.query.mock.calls[0][1].at(-1)).toBe(false);
  });

  it.each([
    ['a running national snapshot', { invalidSnapshotCount: 1 }],
    ['a bootstrap barrier', { invalidSnapshotCount: 1 }],
    ['a pending current queue', { pendingCurrentQueueCount: 1 }],
    ['an unprepared previous-day boundary', { legacyBoundaryEligible: false }],
  ])('refuses materialization across %s', async (_label, override) => {
    if ('legacyBoundaryEligible' in override) {
      process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED = 'true';
    }
    const { service } = createService();
    const manager = {
      query: jest.fn(async (sql: string) =>
        sql.includes('AS "invalidSnapshotCount"')
          ? [
              {
                revision: '12',
                currentPublishedDate: '2026-08-15',
                historicDirtyFrom: candidate.historicDirtyFrom,
                historicDirtyThrough: candidate.historicDirtyThrough,
                historicMapCursor: candidate.historicMapCursor,
                historicStatsCursor: candidate.historicStatsCursor,
                sourceRevision: '42',
                historicComputeEpoch: '7',
                legacyBoundaryEligible: true,
                pendingCurrentQueueCount: 0,
                invalidSnapshotCount: 0,
                ...override,
              },
            ]
          : [],
      ),
    };

    await expect(
      (service as any).persistPublication(
        manager,
        publicationId,
        candidate,
        (service as any).encodeArtifacts(candidate),
      ),
    ).rejects.toThrow('materialization boundary changed');
    expect(
      manager.query.mock.calls.some(([sql]) =>
        sql.includes('INSERT INTO "statistic_cache_publication"'),
      ),
    ).toBe(false);
    expect(manager.query.mock.calls[0][0]).toContain(
      'AS "legacyBoundaryEligible"',
    );
    if ('legacyBoundaryEligible' in override) {
      expect(manager.query.mock.calls[0][1].at(-1)).toBe(true);
    }
  });

  it('uses repeatable read and returns the exact publication produced by one materializer', async () => {
    const { service, dataSource } = createService();
    const payload = {
      identity: {
        id: publicationId,
        statisticRevision: '12',
        currentPublishedDate: '2026-08-15',
      },
    } as any;
    const manager = { query: jest.fn() };
    const queryRunner = {
      manager,
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      query: jest.fn(async (sql: string) =>
        sql.includes('pg_advisory_unlock')
          ? [{ unlocked: true }]
          : [{ locked: true }],
      ),
    };
    dataSource.createQueryRunner.mockReturnValue(queryRunner);
    jest.spyOn(service, 'loadActive').mockResolvedValue(null);
    jest.spyOn(service, 'loadPublication').mockResolvedValue(payload);
    jest
      .spyOn(service as any, 'persistPublication')
      .mockResolvedValue(undefined);
    const factory = jest.fn().mockResolvedValue(candidate);

    await expect(
      service.materialize(
        { statisticRevision: '12', currentPublishedDate: '2026-08-15' },
        factory,
      ),
    ).resolves.toBe(payload);

    expect(queryRunner.startTransaction).toHaveBeenCalledWith(
      'REPEATABLE READ',
    );
    expect(factory).toHaveBeenCalledWith(manager);
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('releases every advisory lock independently and preserves the primary error', async () => {
    const { service, dataSource } = createService();
    const primaryError = new Error('candidate failed');
    const manager = { query: jest.fn() };
    const queryRunner = {
      manager,
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest
        .fn()
        .mockRejectedValue(new Error('rollback failed')),
      release: jest.fn(),
      query: jest.fn(async (sql: string, parameters?: unknown[]) => {
        if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
        if (sql.includes('pg_advisory_unlock_all')) return [{}];
        if (
          sql.includes('pg_advisory_unlock') &&
          parameters?.[0] === 'vigieau:statistic-commune:snapshot-computation'
        ) {
          throw new Error('commune unlock failed');
        }
        if (sql.includes('pg_advisory_unlock')) return [{ unlocked: false }];
        return [];
      }),
    };
    dataSource.createQueryRunner.mockReturnValue(queryRunner);
    jest.spyOn(service, 'loadActive').mockResolvedValue(null);

    await expect(
      service.materialize(
        { statisticRevision: '12', currentPublishedDate: '2026-08-15' },
        async () => {
          throw primaryError;
        },
      ),
    ).rejects.toBe(primaryError);

    expect(queryRunner.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock_all()',
    );
    expect(
      queryRunner.query.mock.calls.filter(([sql]) =>
        String(sql).includes('AS unlocked'),
      ),
    ).toHaveLength(3);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('fails a successful materialization when a lock reports it was not released', async () => {
    const { service, dataSource } = createService();
    const payload = {
      identity: {
        id: publicationId,
        statisticRevision: '12',
        currentPublishedDate: '2026-08-15',
      },
    } as any;
    const queryRunner = {
      manager: { query: jest.fn() },
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
        if (sql.includes('pg_advisory_unlock_all')) return [{}];
        if (sql.includes('pg_advisory_unlock')) return [{ unlocked: false }];
        return [];
      }),
    };
    dataSource.createQueryRunner.mockReturnValue(queryRunner);
    jest.spyOn(service, 'loadActive').mockResolvedValue(null);
    jest.spyOn(service, 'loadPublication').mockResolvedValue(payload);
    jest
      .spyOn(service as any, 'persistPublication')
      .mockResolvedValue(undefined);

    await expect(
      service.materialize(
        { statisticRevision: '12', currentPublishedDate: '2026-08-15' },
        async () => candidate,
      ),
    ).rejects.toThrow(
      'Failed to clean up statistic cache materialization session',
    );
    expect(queryRunner.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock_all()',
    );
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back active/previous under an exact serializable guard', async () => {
    const { service, dataSource } = createService();
    const restored = { identity: { id: previousPublicationId } } as any;
    const queryRunner = {
      manager: {},
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
        if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
        if (sql.includes('AS "activeStatus"')) {
          return [
            {
              activePublicationId: publicationId,
              previousPublicationId,
              activeStatus: 'active',
              previousStatus: 'retired',
            },
          ];
        }
        return [];
      }),
    };
    dataSource.createQueryRunner.mockReturnValue(queryRunner);
    jest.spyOn(service, 'loadPublication').mockResolvedValue(restored);

    await expect(
      service.rollbackToPrevious({
        activePublicationId: publicationId,
        previousPublicationId,
      }),
    ).resolves.toBe(restored);

    expect(queryRunner.startTransaction).toHaveBeenCalledWith('SERIALIZABLE');
    expect(queryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining(`SET "status" = 'active'`),
      [previousPublicationId],
    );
    expect(queryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "statistic_cache_state"'),
      [previousPublicationId, publicationId],
    );
  });
});
