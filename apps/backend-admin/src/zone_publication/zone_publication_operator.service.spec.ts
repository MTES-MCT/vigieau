import { ZonePublicationOperatorService } from './zone_publication_operator.service';
import { ZONE_PUBLICATION_MATERIALIZATION_VERSION } from './zone_publication.config';

describe('ZonePublicationOperatorService', () => {
  const previousEnabled = process.env.ZONE_PUBLICATION_ENABLED;

  afterEach(() => {
    if (previousEnabled === undefined) {
      delete process.env.ZONE_PUBLICATION_ENABLED;
    } else {
      process.env.ZONE_PUBLICATION_ENABLED = previousEnabled;
    }
    jest.clearAllMocks();
  });

  it('dry-runs then atomically separates public revision and queues every department', async () => {
    let separated = false;
    const manager = {
      query: jest.fn(async (sql: string, parameters?: unknown[]) => {
        if (sql.includes('FROM "zone_publication_source_state"')) {
          return [
            {
              revision: '166500',
              publicRevision: '166500',
              legacyDualWrite: !separated,
            },
          ];
        }
        if (sql.includes('array_agg("id"')) {
          return [{ ids: [1, 49, 79] }];
        }
        if (sql.includes('UPDATE "zone_publication_source_state"')) {
          expect(parameters).toEqual([false]);
          separated = true;
          return [{ revision: '166500', publicRevision: '166500' }];
        }
        if (sql.includes('INSERT INTO "current_zone_recompute_request"')) {
          return [];
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    };
    const service = new ZonePublicationOperatorService(dataSource as any);

    await expect(
      service.setPublicRevisionMode({ mode: 'separated' }),
    ).resolves.toEqual({
      status: 'dry_run',
      mode: 'separated',
      revision: '166500',
      publicRevision: '166500',
      queuedDepartmentCount: 0,
    });
    await expect(
      service.setPublicRevisionMode({ mode: 'separated', apply: true }),
    ).resolves.toEqual({
      status: 'applied',
      mode: 'separated',
      revision: '166500',
      publicRevision: '166500',
      queuedDepartmentCount: 3,
    });
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO "current_zone_recompute_request"'),
      [[1, 49, 79], '166500', 'SEPARATION REVISION PUBLIQUE', null],
    );
  });

  it('realigns public revision before returning to rolling compatibility', async () => {
    const manager = {
      query: jest.fn(async (sql: string, parameters?: unknown[]) => {
        if (sql.includes('FROM "zone_publication_source_state"')) {
          return [
            {
              revision: '166510',
              publicRevision: '166503',
              legacyDualWrite: false,
            },
          ];
        }
        if (sql.includes('array_agg("id"')) {
          return [{ ids: [49] }];
        }
        if (sql.includes('UPDATE "zone_publication_source_state"')) {
          expect(parameters).toEqual([true]);
          return [{ revision: '166510', publicRevision: '166510' }];
        }
        if (sql.includes('INSERT INTO "current_zone_recompute_request"')) {
          return [];
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const service = new ZonePublicationOperatorService({
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    } as any);

    await expect(
      service.setPublicRevisionMode({
        mode: 'compatibility',
        apply: true,
      }),
    ).resolves.toMatchObject({
      status: 'applied',
      mode: 'compatibility',
      revision: '166510',
      publicRevision: '166510',
      queuedDepartmentCount: 1,
    });
  });

  it('realigns both revisions when compatibility is already enabled but drifted', async () => {
    const manager = {
      query: jest.fn(async (sql: string, parameters?: unknown[]) => {
        if (sql.includes('FROM "zone_publication_source_state"')) {
          return [
            {
              revision: '166510',
              publicRevision: '166520',
              legacyDualWrite: true,
            },
          ];
        }
        if (sql.includes('array_agg("id"')) {
          return [{ ids: [49, 79] }];
        }
        if (sql.includes('UPDATE "zone_publication_source_state"')) {
          expect(parameters).toEqual([true]);
          expect(sql).toContain(
            '"revision" = CASE\n              WHEN $1 THEN GREATEST',
          );
          return [{ revision: '166520', publicRevision: '166520' }];
        }
        if (sql.includes('INSERT INTO "current_zone_recompute_request"')) {
          return [];
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const service = new ZonePublicationOperatorService({
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    } as any);

    await expect(
      service.setPublicRevisionMode({
        mode: 'compatibility',
        apply: true,
      }),
    ).resolves.toEqual({
      status: 'applied',
      mode: 'compatibility',
      revision: '166520',
      publicRevision: '166520',
      queuedDepartmentCount: 2,
    });
  });

  it('returns an actionable publication health snapshot', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        {
          sourceRevision: '12',
          activeId: 'active',
          activeRevision: '42',
          activeSourceRevision: '12',
          activeFingerprint: 'a'.repeat(64),
          candidateId: 'retired',
          candidateStatus: 'retired',
          candidateSourceRevision: '11',
          candidateFingerprint: 'b'.repeat(64),
          automaticPublishingPaused: true,
          automaticPublishingPausedAt: new Date('2026-08-01T10:00:00Z'),
          statisticRevision: '7',
          statisticCurrentPublishedDate: '2026-08-01',
          statisticHistoricPublishedThrough: '2026-07-31',
          statisticHistoricDirtyFrom: '2026-07-30',
          statisticHistoricDirtyThrough: '2026-07-31',
          statisticSnapshotDate: '2026-08-02',
          statisticSnapshotScope: 'national',
          statisticSnapshotStatus: 'running',
          statisticSnapshotSourceRevision: '12',
          statisticSnapshotExpectedCommuneCount: 34943,
          statisticSnapshotProcessedCommuneCount: 12500,
          statisticSnapshotStartedAt: new Date('2026-08-02T05:00:00Z'),
          statisticSnapshotUpdatedAt: new Date('2026-08-02T05:03:00Z'),
          incompleteStatisticSnapshotCount: 1,
          liveInstances: 3,
          activeReadyInstances: 3,
          candidateReadyInstances: 2,
        },
      ]),
    };

    await expect(
      new ZonePublicationOperatorService(
        dataSource as any,
      ).getOperationalState(),
    ).resolves.toMatchObject({
      enabled: true,
      sourceRevision: '12',
      automaticPublishing: {
        paused: true,
        pausedAt: new Date('2026-08-01T10:00:00Z'),
      },
      statistics: {
        revision: '7',
        currentPublishedDate: '2026-08-01',
        historicPublishedThrough: '2026-07-31',
        dirtyRange: { from: '2026-07-30', through: '2026-07-31' },
        currentSnapshot: {
          date: '2026-08-02',
          scope: 'national',
          status: 'running',
          sourceRevision: '12',
          progress: {
            expectedCommuneCount: 34943,
            processedCommuneCount: 12500,
          },
          completedAt: null,
        },
        incompleteSnapshotCount: 1,
      },
      active: { id: 'active', fingerprint: 'a'.repeat(64) },
      candidate: {
        id: 'retired',
        mode: 'rollback',
        fingerprint: 'b'.repeat(64),
      },
      quorum: {
        liveInstances: 3,
        activeReadyInstances: 3,
        candidateReadyInstances: 2,
      },
    });
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining(
        'LEFT JOIN "statistic_publication_state" statistic_state',
      ),
      [30],
    );
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining(
        `snapshot."status" NOT IN ('ready', 'completed')`,
      ),
      [30],
    );
  });

  it('returns an empty statistic state without changing existing health fields', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        {
          sourceRevision: '12',
          liveInstances: 1,
          activeReadyInstances: 0,
          candidateReadyInstances: 0,
        },
      ]),
    };

    await expect(
      new ZonePublicationOperatorService(
        dataSource as any,
      ).getOperationalState(),
    ).resolves.toMatchObject({
      sourceRevision: '12',
      active: null,
      candidate: null,
      statistics: {
        revision: null,
        currentPublishedDate: null,
        historicPublishedThrough: null,
        dirtyRange: null,
        currentSnapshot: null,
        incompleteSnapshotCount: 0,
      },
    });
  });

  it('certifies confirmed_none only through an exact revision-pinned operator transaction', async () => {
    const manager = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT "id", "code"')) {
          return [{ id: 49, code: '49' }];
        }
        if (sql.includes('INSERT INTO "zone_type_availability"')) {
          return [[{ departmentCode: '49' }], 1];
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    };
    const service = new ZonePublicationOperatorService(dataSource as any);
    const asOf = '2026-08-19T12:00:00.000Z';

    await expect(
      service.confirmNoAvailableZone({
        departmentCode: '49',
        zoneType: 'AEP',
        publicRevision: '43',
        officialUrl: 'https://www.maine-et-loire.gouv.fr/',
        asOf,
      }),
    ).resolves.toEqual({
      departmentCode: '49',
      zoneType: 'AEP',
      status: 'confirmed_none',
      publicRevision: '43',
    });

    expect(dataSource.transaction).toHaveBeenCalledWith(
      'SERIALIZABLE',
      expect.any(Function),
    );
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('source."publicRevision" = $6::bigint'),
      [
        49,
        'AEP',
        'confirmed_none',
        new Date(asOf),
        'https://www.maine-et-loire.gouv.fr/',
        '43',
      ],
    );
  });

  it('rejects an explicit confirmed_none certification for a superseded revision', async () => {
    const manager = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT "id", "code"')) {
          return [{ id: 49, code: '49' }];
        }
        if (sql.includes('INSERT INTO "zone_type_availability"')) {
          return [[], 0];
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    };

    await expect(
      new ZonePublicationOperatorService(
        dataSource as any,
      ).confirmNoAvailableZone({
        departmentCode: '49',
        zoneType: 'AEP',
        publicRevision: '42',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('normalizes Corsican department codes and rejects non-HTTPS official URLs', async () => {
    const manager = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT "id", "code"')) {
          return [{ id: 20, code: '2A' }];
        }
        if (sql.includes('INSERT INTO "zone_type_availability"')) {
          return [[{ departmentCode: '2A' }], 1];
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    };
    const service = new ZonePublicationOperatorService(dataSource as any);

    await expect(
      service.confirmNoAvailableZone({
        departmentCode: ' 2a ',
        zoneType: 'SUP',
        publicRevision: '43',
      }),
    ).resolves.toMatchObject({ departmentCode: '2A' });
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM "departement"'),
      ['2A'],
    );
    await expect(
      service.confirmNoAvailableZone({
        departmentCode: '2A',
        zoneType: 'SUP',
        publicRevision: '43',
        officialUrl: 'http://www.corse-du-sud.gouv.fr/',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('keeps rollback preparation read-only during a dry run', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const manager = buildManager();
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    };
    const service = new ZonePublicationOperatorService(dataSource as any);

    await expect(service.prepareRollback()).resolves.toMatchObject({
      status: 'dry_run',
      activePublicationId: 'active',
      targetPublicationId: 'retired',
      liveInstances: 2,
      readyInstances: 0,
      blockers: [],
    });
    expect(
      manager.query.mock.calls.some(([sql]) =>
        sql.includes('UPDATE "zone_publication_state"'),
      ),
    ).toBe(false);
  });

  it('blocks rollback targets that cannot restore statistics for the current source', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const manager = buildManager({
      target: {
        sourceRevision: '41',
        materializationVersion: 2,
        hasCertifiedStatisticSnapshot: false,
        incompleteStatisticSnapshotCount: 2,
      },
    });
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    };

    await expect(
      new ZonePublicationOperatorService(dataSource as any).prepareRollback({
        publicationId: 'retired',
      }),
    ).resolves.toMatchObject({
      status: 'blocked',
      blockers: [
        'target source revision 41 does not match current source revision 42',
        `target materialization version 2 does not match current version ${ZONE_PUBLICATION_MATERIALIZATION_VERSION}`,
        'target has no certified national statistic snapshot for its source revision',
        '2 incomplete statistic snapshot(s) exist on or before the target date',
      ],
    });
    expect(
      manager.query.mock.calls.some(([sql]) => sql.includes('UPDATE ')),
    ).toBe(false);
  });

  it('prepares a validated rollback for quorum preload without activating it', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const manager = buildManager();
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    };
    const service = new ZonePublicationOperatorService(dataSource as any);

    await expect(
      service.prepareRollback({ publicationId: 'retired', apply: true }),
    ).resolves.toMatchObject({
      status: 'prepared',
      targetPublicationId: 'retired',
      blockers: [],
    });
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('"candidatePublicationId" = $1'),
      ['retired'],
    );
    expect(
      manager.query.mock.calls.some(([sql]) =>
        sql.includes('"automaticPublishingPaused" = true'),
      ),
    ).toBe(true);
    expect(
      manager.query.mock.calls.some(([sql]) =>
        sql.includes(`SET "status" = 'active'`),
      ),
    ).toBe(false);
  });

  it('persists the pause when the rollback candidate was already prepared', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const manager = buildManager({ candidatePublicationId: 'retired' });
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    };
    const service = new ZonePublicationOperatorService(dataSource as any);

    await expect(
      service.prepareRollback({ publicationId: 'retired', apply: true }),
    ).resolves.toMatchObject({ status: 'candidate_pending' });
    expect(
      manager.query.mock.calls.some(
        ([sql]) =>
          sql.includes('"automaticPublishingPaused" = true') &&
          !sql.includes('"candidatePublicationId" = $1'),
      ),
    ).toBe(true);
  });

  it('requires the exact dry-run target before applying a rollback', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const dataSource = { transaction: jest.fn() };
    const service = new ZonePublicationOperatorService(dataSource as any);

    await expect(service.prepareRollback({ apply: true })).resolves.toEqual({
      status: 'blocked',
      blockers: ['publicationId from a prior rollback dry-run is required'],
    });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('blocks rollback while historic statistics are dirty', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const manager = buildManager({
      historicDirtyFrom: '2026-07-31',
      historicDirtyThrough: '2026-08-01',
    });
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    };
    const service = new ZonePublicationOperatorService(dataSource as any);

    await expect(
      service.prepareRollback({ publicationId: 'retired', apply: true }),
    ).resolves.toMatchObject({
      status: 'blocked',
      blockers: [
        'historic statistics are dirty from 2026-07-31 through 2026-08-01',
      ],
    });
    expect(
      manager.query.mock.calls.some(
        ([sql]) =>
          sql.includes('UPDATE "zone_publication_state"') &&
          sql.includes('"candidatePublicationId" = $1'),
      ),
    ).toBe(false);
  });

  it('atomically supersedes a normal candidate before preparing rollback', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const manager = buildManager({
      candidatePublicationId: 'normal-candidate',
      candidateStatus: 'candidate',
    });
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    };
    const service = new ZonePublicationOperatorService(dataSource as any);

    await expect(
      service.prepareRollback({ publicationId: 'retired', apply: true }),
    ).resolves.toMatchObject({
      status: 'prepared',
      replacedCandidatePublicationId: 'normal-candidate',
      pendingCandidate: {
        id: 'normal-candidate',
        status: 'candidate',
        replaceable: true,
      },
    });
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining(`SET "status" = 'superseded'`),
      ['normal-candidate'],
    );
    const replaceOrder = manager.query.mock.calls.findIndex(([sql]) =>
      sql.includes(`SET "status" = 'superseded'`),
    );
    const stateOrder = manager.query.mock.calls.findIndex(
      ([sql]) =>
        sql.includes('UPDATE "zone_publication_state"') &&
        sql.includes('"candidatePublicationId" = $1'),
    );
    expect(replaceOrder).toBeGreaterThanOrEqual(0);
    expect(stateOrder).toBeGreaterThan(replaceOrder);
  });

  it('never replaces another rollback candidate', async () => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    const manager = buildManager({
      candidatePublicationId: 'other-retired',
      candidateStatus: 'retired',
    });
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    };
    const service = new ZonePublicationOperatorService(dataSource as any);

    await expect(
      service.prepareRollback({ publicationId: 'retired', apply: true }),
    ).resolves.toMatchObject({
      status: 'blocked',
      pendingCandidate: {
        id: 'other-retired',
        status: 'retired',
        replaceable: false,
      },
    });
    expect(
      manager.query.mock.calls.some(([sql]) =>
        sql.includes(`SET "status" = 'superseded'`),
      ),
    ).toBe(false);
    expect(
      manager.query.mock.calls.some(
        ([sql]) =>
          sql.includes('UPDATE "zone_publication_state"') &&
          sql.includes('"candidatePublicationId" = $1'),
      ),
    ).toBe(false);
  });

  it('resumes automatic publishing and cancels a pending rollback explicitly', async () => {
    const manager = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM "zone_publication_state"')) {
          return [
            {
              automaticPublishingPaused: true,
              candidatePublicationId: 'retired',
              candidateStatus: 'retired',
            },
          ];
        }
        return [];
      }),
    };
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    };
    const service = new ZonePublicationOperatorService(dataSource as any);

    await expect(service.resumeAutomaticPublishing()).resolves.toEqual({
      status: 'resumed',
      cancelledRollbackPublicationId: 'retired',
    });
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('"automaticPublishingPaused" = false'),
      [true],
    );
  });
});

function buildManager(options?: {
  candidatePublicationId?: string | null;
  candidateStatus?: string;
  target?: Record<string, unknown>;
  historicDirtyFrom?: string | null;
  historicDirtyThrough?: string | null;
}) {
  return {
    query: jest.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes('FROM "zone_publication_state"')) {
        return [
          {
            activePublicationId: 'active',
            candidatePublicationId: options?.candidatePublicationId ?? null,
            currentSourceRevision: '42',
            historicDirtyFrom: options?.historicDirtyFrom ?? null,
            historicDirtyThrough: options?.historicDirtyThrough ?? null,
          },
        ];
      }
      if (
        sql.includes('SELECT "id", "status"') &&
        sql.includes('FROM "zone_publication"')
      ) {
        return [
          {
            id: options?.candidatePublicationId,
            status: options?.candidateStatus ?? 'retired',
          },
        ];
      }
      if (sql.includes('FROM "zone_publication" publication')) {
        return [
          {
            id: 'retired',
            sourceRevision: '42',
            materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
            zoneCount: 10,
            communeLinkCount: 20,
            contentFingerprint: 'a'.repeat(64),
            geojsonUrl: 'https://example.test/zones.geojson',
            geojsonChecksum: 'b'.repeat(64),
            pmtilesUrl: 'https://example.test/zones.pmtiles',
            pmtilesChecksum: 'c'.repeat(64),
            hasAggregate: true,
            hasCertifiedStatisticSnapshot: true,
            incompleteStatisticSnapshotCount: 0,
            ...(options?.target || {}),
          },
        ];
      }
      if (sql.includes('FROM "zone_publication_instance"')) {
        return [{ liveInstances: 2, readyInstances: 0 }];
      }
      if (
        sql.includes(`SET "status" = 'superseded'`) &&
        parameters?.[0] === options?.candidatePublicationId
      ) {
        return [{ id: options?.candidatePublicationId }];
      }
      return [];
    }),
  };
}
