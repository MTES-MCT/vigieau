import { ZonePublicationOperatorService } from './zone_publication_operator.service';

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
}) {
  return {
    query: jest.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes('FROM "zone_publication_state"')) {
        return [
          {
            activePublicationId: 'active',
            candidatePublicationId: options?.candidatePublicationId ?? null,
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
            zoneCount: 10,
            communeLinkCount: 20,
            contentFingerprint: 'a'.repeat(64),
            geojsonUrl: 'https://example.test/zones.geojson',
            geojsonChecksum: 'b'.repeat(64),
            pmtilesUrl: 'https://example.test/zones.pmtiles',
            pmtilesChecksum: 'c'.repeat(64),
            hasAggregate: true,
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
