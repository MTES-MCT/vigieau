import {
  buildZonePublicPayload,
  computeZonePublicationRetryBackoffSeconds,
  ZonePublicationService,
  ZoneSourceRow,
  ZoneUsageRow,
} from './zone_publication.service';
import { createHash } from 'node:crypto';

const GEOJSON_ARTIFACT = Buffer.from('{"type":"FeatureCollection"}');
const PMTILES_ARTIFACT = (() => {
  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'ascii');
  header.writeUInt8(3, 7);
  [8, 24, 40, 56].forEach((offset) => header.writeBigUInt64LE(127n, offset));
  header.writeUInt8(1, 99);
  return header;
})();
const GEOJSON_CHECKSUM = createHash('sha256')
  .update(GEOJSON_ARTIFACT)
  .digest('hex');
const PMTILES_CHECKSUM = createHash('sha256')
  .update(PMTILES_ARTIFACT)
  .digest('hex');

function sourceZone(overrides: Partial<ZoneSourceRow> = {}): ZoneSourceRow {
  return {
    id: 42,
    idSandre: 100,
    code: 'ZA-42',
    nom: 'Zone test',
    type: 'SUP',
    ressourceInfluencee: false,
    niveauGravite: 'alerte',
    departmentId: 65,
    departmentCode: '65',
    publicDepartmentCode: '65',
    restrictionId: 7,
    arreteId: 8,
    dateDebutValidite: '2026-07-01',
    dateFinValidite: '2026-08-01',
    cheminFichier: 'https://example.test/ar.pdf',
    cheminFichierArreteCadre: 'https://example.test/ac.pdf',
    ...overrides,
  };
}

function sourceUsage(overrides: Partial<ZoneUsageRow> = {}): ZoneUsageRow {
  return {
    id: 1,
    restrictionId: 7,
    nom: 'Arrosage',
    thematique: 'Particuliers',
    concerneParticulier: true,
    concerneEntreprise: false,
    concerneCollectivite: false,
    concerneExploitation: false,
    concerneEso: false,
    concerneEsu: true,
    concerneAep: false,
    descriptionVigilance: 'Vigilance',
    descriptionAlerte: 'Alerte',
    descriptionAlerteRenforcee: 'Alerte renforcee',
    descriptionCrise: 'Crise',
    ...overrides,
  };
}

describe('buildZonePublicPayload', () => {
  it('reproduces public fields and filters usages by zone resource', () => {
    const payload = buildZonePublicPayload(sourceZone(), [
      sourceUsage(),
      sourceUsage({ id: 2, concerneEsu: false, concerneEso: true }),
    ]);

    expect(payload).toEqual(
      expect.objectContaining({
        id: 42,
        type: 'SUP',
        departement: '65',
        arrete: expect.objectContaining({ id: 8 }),
        usages: [
          expect.objectContaining({
            id: 1,
            description: 'Alerte',
            concerneParticulier: true,
          }),
        ],
      }),
    );
  });

  it('keeps the current empty restriction representation', () => {
    const payload = buildZonePublicPayload(
      sourceZone({ restrictionId: null, arreteId: null }),
      [],
    );

    expect(payload.arrete).toEqual({});
    expect(payload).not.toHaveProperty('departement');
    expect(payload).not.toHaveProperty('usages');
  });

  it('keeps the legacy empty description when the restriction level is missing', () => {
    const payload = buildZonePublicPayload(
      sourceZone({ niveauGravite: null }),
      [sourceUsage()],
    );

    expect(
      (payload.usages as Array<{ description: string }>)[0].description,
    ).toBe('');
  });

  it('omits optional relation fields when the legacy payload would use undefined', () => {
    const payload = buildZonePublicPayload(
      sourceZone({
        publicDepartmentCode: null,
        cheminFichier: null,
        cheminFichierArreteCadre: null,
      }),
      [sourceUsage({ thematique: null })],
    );

    expect(payload).not.toHaveProperty('departement');
    expect(payload.arrete).not.toHaveProperty('cheminFichier');
    expect(payload.arrete).not.toHaveProperty('cheminFichierArreteCadre');
    expect(
      (payload.usages as Array<Record<string, unknown>>)[0],
    ).not.toHaveProperty('thematique');
  });
});

describe('computeZonePublicationRetryBackoffSeconds', () => {
  it('doubles from the configured base for each persisted failure', () => {
    expect(computeZonePublicationRetryBackoffSeconds(1, 300, 21_600)).toBe(300);
    expect(computeZonePublicationRetryBackoffSeconds(2, 300, 21_600)).toBe(600);
    expect(computeZonePublicationRetryBackoffSeconds(3, 300, 21_600)).toBe(
      1_200,
    );
  });

  it('caps the backoff and returns no delay without a failed publication', () => {
    expect(computeZonePublicationRetryBackoffSeconds(0, 300, 21_600)).toBe(0);
    expect(computeZonePublicationRetryBackoffSeconds(100, 300, 21_600)).toBe(
      21_600,
    );
  });
});

describe('ZonePublicationService', () => {
  let fetchSpy: jest.SpyInstance;
  const previousPublicationEnabled = process.env.ZONE_PUBLICATION_ENABLED;

  beforeEach(() => {
    process.env.ZONE_PUBLICATION_ENABLED = 'true';
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url) => {
        const content = String(url).endsWith('.pmtiles')
          ? PMTILES_ARTIFACT
          : GEOJSON_ARTIFACT;
        return new Response(content, { status: 200 });
      });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  afterAll(() => {
    if (previousPublicationEnabled === undefined) {
      delete process.env.ZONE_PUBLICATION_ENABLED;
    } else {
      process.env.ZONE_PUBLICATION_ENABLED = previousPublicationEnabled;
    }
  });

  it('requests recomputation only when neither active nor candidate matches', async () => {
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValueOnce([
          {
            sourceRevision: '10',
            activeRevision: '9',
            activeMaterializationVersion: 1,
            candidateRevision: null,
            candidateMaterializationVersion: null,
            failureCount: 0,
          },
        ])
        .mockResolvedValueOnce([
          {
            sourceRevision: '10',
            activeRevision: '9',
            activeMaterializationVersion: 1,
            candidateRevision: '10',
            candidateMaterializationVersion: 1,
            failureCount: 0,
          },
        ]),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(service.isRecomputeRequired()).resolves.toBe(true);
    await expect(service.isRecomputeRequired()).resolves.toBe(false);
  });

  it('forces recomputation when the materialization algorithm changes', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        {
          sourceRevision: '10',
          activeRevision: '10',
          activeMaterializationVersion: 0,
          candidateRevision: null,
          candidateMaterializationVersion: null,
          failureCount: 0,
          recentInProgress: false,
        },
      ]),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(service.isRecomputeRequired()).resolves.toBe(true);
  });

  it('keeps publication build and activation inactive unless explicitly enabled', async () => {
    delete process.env.ZONE_PUBLICATION_ENABLED;
    const dataSource = { query: jest.fn(), transaction: jest.fn() };
    const service = new ZonePublicationService(dataSource as any);

    await expect(service.isRecomputeRequired()).resolves.toBe(false);
    await expect(service.activateWhenReady()).resolves.toEqual({
      status: 'disabled',
    });
    await expect(
      service.buildCandidateFromCurrentComputed({
        sourceRevision: '1',
        sourceComputedAt: new Date(),
        artifactZoneCount: 0,
        geojsonUrl: 'https://example.test/zones.geojson',
        geojsonChecksum: GEOJSON_CHECKSUM,
        pmtilesUrl: 'https://example.test/zones.pmtiles',
        pmtilesChecksum: PMTILES_CHECKSUM,
      }),
    ).rejects.toThrow('Zone publication is disabled');
    expect(dataSource.query).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('applies persisted exponential backoff to failures of the current revision', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        {
          sourceRevision: '10',
          activeRevision: '9',
          activeMaterializationVersion: 1,
          candidateRevision: null,
          candidateMaterializationVersion: null,
          failureCount: '3',
          lastFailureAt: new Date('2026-07-31T11:50:00Z'),
          databaseNow: new Date('2026-07-31T12:00:00Z'),
          recentInProgress: false,
        },
      ]),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(service.isRecomputeRequired()).resolves.toBe(false);
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.any(String),
      [4500, 1],
    );
    const query = dataSource.query.mock.calls[0][0] as string;
    expect(query).toContain('failed."sourceRevision" = source."revision"');
    expect(query).toContain('failed."materializationVersion" = $2');
  });

  it('retries after the persisted exponential backoff has elapsed', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        {
          sourceRevision: '10',
          activeRevision: '9',
          activeMaterializationVersion: 1,
          candidateRevision: null,
          candidateMaterializationVersion: null,
          failureCount: '3',
          lastFailureAt: new Date('2026-07-31T11:39:59Z'),
          databaseNow: new Date('2026-07-31T12:00:00Z'),
          recentInProgress: false,
        },
      ]),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(service.isRecomputeRequired()).resolves.toBe(true);
  });

  it('uses the configured maximum retry backoff', async () => {
    const previousMaxBackoff =
      process.env.ZONE_PUBLICATION_RETRY_MAX_BACKOFF_SECONDS;
    process.env.ZONE_PUBLICATION_RETRY_MAX_BACKOFF_SECONDS = '600';
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        {
          sourceRevision: '10',
          activeRevision: '9',
          activeMaterializationVersion: 1,
          candidateRevision: null,
          candidateMaterializationVersion: null,
          failureCount: '4',
          lastFailureAt: new Date('2026-07-31T11:48:20Z'),
          databaseNow: new Date('2026-07-31T12:00:00Z'),
          recentInProgress: false,
        },
      ]),
    };
    const service = new ZonePublicationService(dataSource as any);

    try {
      await expect(service.isRecomputeRequired()).resolves.toBe(true);
    } finally {
      if (previousMaxBackoff === undefined) {
        delete process.env.ZONE_PUBLICATION_RETRY_MAX_BACKOFF_SECONDS;
      } else {
        process.env.ZONE_PUBLICATION_RETRY_MAX_BACKOFF_SECONDS =
          previousMaxBackoff;
      }
    }
  });

  it('does not start a duplicate build while the current revision is in progress', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        {
          sourceRevision: '10',
          activeRevision: '9',
          activeMaterializationVersion: 1,
          candidateRevision: null,
          candidateMaterializationVersion: null,
          failureCount: 0,
          recentInProgress: true,
        },
      ]),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(service.isRecomputeRequired()).resolves.toBe(false);
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.any(String),
      [4500, 1],
    );
  });

  it('supersedes a candidate when its source revision changed', async () => {
    const executed: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string) => {
        executed.push(sql);
        if (
          sql.includes('FROM "zone_publication"') &&
          sql.includes('FOR UPDATE')
        ) {
          return [
            {
              id: 'candidate',
              status: 'validated',
              sourceRevision: '5',
              materializationVersion: 1,
            },
          ];
        }
        if (sql.includes('FROM "zone_publication_source_state"')) {
          return [{ revision: '6' }];
        }
        if (sql.includes('FROM "zone_publication_state"')) {
          return [
            {
              activePublicationId: 'active',
              candidatePublicationId: null,
            },
          ];
        }
        return [];
      }),
    };
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(service.markCandidate('candidate')).resolves.toBe(false);
    expect(
      executed.some(
        (sql) =>
          sql.includes(`SET "status" = 'superseded'`) &&
          sql.includes('"zone_publication"'),
      ),
    ).toBe(true);
    expect(
      executed.some((sql) => sql.includes('SET "candidatePublicationId"')),
    ).toBe(false);
    const lockStatements = executed.filter((sql) => sql.includes('FOR UPDATE'));
    expect(lockStatements[0]).toContain('zone_publication_source_state');
    expect(lockStatements[1]).toContain('FROM "zone_publication_state"');
    expect(lockStatements[2]).toContain('FROM "zone_publication"');
  });

  it('keeps the active publication when not every live instance is ready', async () => {
    const executed: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string) => {
        executed.push(sql);
        if (sql.includes('FROM "zone_publication_state"')) {
          return [
            {
              activePublicationId: 'active',
              candidatePublicationId: 'candidate',
            },
          ];
        }
        if (sql.includes('FROM "zone_publication"')) {
          return [
            {
              id: 'candidate',
              status: 'candidate',
              sourceRevision: '7',
              materializationVersion: 1,
              zoneCount: 10,
              communeLinkCount: 20,
            },
          ];
        }
        if (sql.includes('FROM "zone_publication_source_state"')) {
          return [{ revision: '7' }];
        }
        if (sql.includes('FROM "zone_publication_instance"')) {
          return [{ liveInstances: 2, readyInstances: 1 }];
        }
        return [];
      }),
    };
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(
      service.activateWhenReady({ minimumReadyInstances: 2 }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'not_ready',
        liveInstances: 2,
        readyInstances: 1,
      }),
    );
    expect(
      executed.some((sql) => sql.includes(`SET "status" = 'active'`)),
    ).toBe(false);
  });

  it('expires an unreadable candidate without changing the active publication', async () => {
    const executed: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string) => {
        executed.push(sql);
        if (sql.includes(`SET "status" = 'failed'`)) {
          return [{ id: 'candidate' }];
        }
        if (sql.includes('FROM "zone_publication_state"')) {
          return [
            {
              activePublicationId: 'active',
              candidatePublicationId: 'candidate',
            },
          ];
        }
        if (
          sql.includes('FROM "zone_publication"') &&
          sql.includes('FOR UPDATE')
        ) {
          return [
            {
              id: 'candidate',
              status: 'candidate',
              sourceRevision: '7',
              materializationVersion: 1,
              zoneCount: 10,
              communeLinkCount: 20,
              candidateAt: new Date('2020-01-01T00:00:00Z'),
            },
          ];
        }
        if (sql.includes('FROM "zone_publication_source_state"')) {
          return [{ revision: '7' }];
        }
        if (sql.includes('FROM "zone_publication_instance"')) {
          return [{ liveInstances: 2, readyInstances: 1 }];
        }
        return [];
      }),
    };
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(
      service.activateWhenReady({
        minimumReadyInstances: 2,
        candidateTimeoutSeconds: 300,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'failed',
        publicationId: 'candidate',
      }),
    );
    expect(
      executed.some(
        (sql) =>
          sql.includes(`SET "status" = 'failed'`) &&
          sql.includes('"failedAt" = now()'),
      ),
    ).toBe(true);
    expect(
      executed.some(
        (sql) =>
          sql.includes('"candidatePublicationId" = NULL') &&
          !sql.includes('"activePublicationId" ='),
      ),
    ).toBe(true);
    expect(
      executed.some((sql) => sql.includes(`SET "status" = 'retired'`)),
    ).toBe(false);
  });

  it('keeps waiting when every live instance is ready but one expected instance is missing', async () => {
    const executed: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string) => {
        executed.push(sql);
        if (sql.includes('FROM "zone_publication_state"')) {
          return [
            {
              activePublicationId: 'active',
              candidatePublicationId: 'candidate',
            },
          ];
        }
        if (
          sql.includes('FROM "zone_publication"') &&
          sql.includes('FOR UPDATE')
        ) {
          return [
            {
              id: 'candidate',
              status: 'candidate',
              sourceRevision: '7',
              materializationVersion: 1,
              zoneCount: 10,
              communeLinkCount: 20,
              candidateAt: new Date('2020-01-01T00:00:00Z'),
            },
          ];
        }
        if (sql.includes('FROM "zone_publication_source_state"')) {
          return [{ revision: '7' }];
        }
        if (sql.includes('FROM "zone_publication_instance"')) {
          return [{ liveInstances: 1, readyInstances: 1 }];
        }
        return [];
      }),
    };
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(
      service.activateWhenReady({
        minimumReadyInstances: 2,
        candidateTimeoutSeconds: 300,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'not_ready',
        liveInstances: 1,
        readyInstances: 1,
      }),
    );
    expect(
      executed.some((sql) => sql.includes(`SET "status" = 'failed'`)),
    ).toBe(false);
  });

  it('atomically activates a fully preloaded publication', async () => {
    const executed: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string) => {
        executed.push(sql);
        if (sql.includes('pg_try_advisory_xact_lock')) {
          return [{ locked: true }];
        }
        if (sql.includes(`SET "status" = 'active'`)) {
          return [{ id: 'candidate' }];
        }
        if (sql.includes('FROM "zone_publication_state"')) {
          return [
            {
              activePublicationId: 'active',
              candidatePublicationId: 'candidate',
            },
          ];
        }
        if (sql.includes('FROM "zone_publication"')) {
          return [
            {
              id: 'candidate',
              status: 'candidate',
              sourceRevision: '7',
              materializationVersion: 1,
              zoneCount: 10,
              communeLinkCount: 20,
            },
          ];
        }
        if (sql.includes('FROM "zone_publication_source_state"')) {
          return [{ revision: '7' }];
        }
        if (sql.includes('FROM "zone_publication_instance"')) {
          return [{ liveInstances: 2, readyInstances: 2 }];
        }
        return [];
      }),
    };
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(
      service.activateWhenReady({ minimumReadyInstances: 2 }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'activated',
        publicationId: 'candidate',
      }),
    );
    expect(
      executed.some((sql) => sql.includes(`SET "status" = 'retired'`)),
    ).toBe(true);
    expect(
      executed.some((sql) => sql.includes(`SET "status" = 'active'`)),
    ).toBe(true);
    expect(
      executed.some(
        (sql) =>
          sql.includes('"activePublicationId" = $1') &&
          sql.includes('"candidatePublicationId" = NULL'),
      ),
    ).toBe(true);
    const lockStatements = executed.filter((sql) => sql.includes('FOR UPDATE'));
    expect(lockStatements[0]).toContain('zone_publication_source_state');
    expect(lockStatements[1]).toContain('FROM "zone_publication_state"');
    expect(lockStatements[2]).toContain('FROM "zone_publication"');
    const promotionLockIndex = executed.findIndex((sql) =>
      sql.includes('pg_try_advisory_xact_lock(hashtext($1))'),
    );
    const quorumIndex = executed.findIndex((sql) =>
      sql.includes('FROM "zone_publication_instance"'),
    );
    const retiredIndex = executed.findIndex((sql) =>
      sql.includes(`SET "status" = 'retired'`),
    );
    const activeIndex = executed.findIndex((sql) =>
      sql.includes(`SET "status" = 'active'`),
    );
    const stateSwitchIndex = executed.findIndex(
      (sql) =>
        sql.includes('UPDATE "zone_publication_state"') &&
        sql.includes('"activePublicationId" = $1'),
    );
    expect(promotionLockIndex).toBeGreaterThan(quorumIndex);
    expect(promotionLockIndex).toBeLessThan(retiredIndex);
    expect(promotionLockIndex).toBeLessThan(activeIndex);
    expect(promotionLockIndex).toBeLessThan(stateSwitchIndex);
  });

  it('retries activation later when stable promotion owns the shared lock', async () => {
    const executed: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string) => {
        executed.push(sql);
        if (sql.includes('pg_try_advisory_xact_lock')) {
          return [{ locked: false }];
        }
        if (sql.includes('FROM "zone_publication_state"')) {
          return [
            {
              activePublicationId: 'active',
              candidatePublicationId: 'candidate',
            },
          ];
        }
        if (sql.includes('FROM "zone_publication"')) {
          return [
            {
              id: 'candidate',
              status: 'candidate',
              sourceRevision: '7',
              materializationVersion: 1,
              zoneCount: 10,
              communeLinkCount: 20,
            },
          ];
        }
        if (sql.includes('FROM "zone_publication_source_state"')) {
          return [{ revision: '7' }];
        }
        if (sql.includes('FROM "zone_publication_instance"')) {
          return [{ liveInstances: 2, readyInstances: 2 }];
        }
        return [];
      }),
    };
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(
      service.activateWhenReady({ minimumReadyInstances: 2 }),
    ).resolves.toEqual({
      status: 'busy',
      publicationId: 'candidate',
      liveInstances: 2,
      readyInstances: 2,
    });
    expect(
      executed.some((sql) => sql.includes(`SET "status" = 'retired'`)),
    ).toBe(false);
    expect(
      executed.some((sql) => sql.includes(`SET "status" = 'active'`)),
    ).toBe(false);
    expect(
      executed.some(
        (sql) =>
          sql.includes('UPDATE "zone_publication_state"') &&
          sql.includes('"activePublicationId" = $1'),
      ),
    ).toBe(false);
  });

  it('purges only expired disposable publications with safe defaults', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([{ id: 'expired-retired' }]),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(service.purgeExpiredPublications()).resolves.toEqual([
      'expired-retired',
    ]);
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining(
        `publication."status" IN ('retired', 'superseded', 'failed')`,
      ),
      [4, 48],
    );
    const sql = dataSource.query.mock.calls[0][0];
    expect(sql).toContain(
      `publication."id" IS DISTINCT FROM state."activePublicationId"`,
    );
    expect(sql).toContain(
      `publication."id" IS DISTINCT FROM state."candidatePublicationId"`,
    );
    expect(sql).not.toContain(`'active', 'candidate'`);
  });

  it('uses explicit retention limits when provided', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([]),
    };
    const service = new ZonePublicationService(dataSource as any);

    await service.purgeExpiredPublications({
      retainedRetiredCount: 6,
      retentionHours: 72,
    });

    expect(dataSource.query).toHaveBeenCalledWith(expect.any(String), [6, 72]);
  });

  it('makes abandoned building and validated publications purgeable', async () => {
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'building' }])
        .mockResolvedValueOnce([{ id: 'validated' }]),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(service.expireStalePublications(600)).resolves.toEqual([
      'building',
      'validated',
    ]);
    expect(dataSource.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(`SET "status" = 'failed'`),
      [600],
    );
    expect(dataSource.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(`SET "status" = 'superseded'`),
      [600],
    );
  });

  it('purges stale instance heartbeats independently from publications', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([{ instanceId: 'old-process' }]),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(service.purgeExpiredInstanceHeartbeats(12)).resolves.toEqual([
      'old-process',
    ]);
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM "zone_publication_instance"'),
      [12],
    );
  });

  it('accepts a positive bootstrap snapshot without an active baseline', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };
    const service = new ZonePublicationService({} as any);

    await expect(
      (service as any).assertPlausibleSnapshot(manager, {
        zoneCount: 10,
        communeLinkCount: 20,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects zero commune associations and implausible link density', async () => {
    const previous = process.env.ZONE_PUBLICATION_MIN_LINK_DENSITY_PERCENT;
    process.env.ZONE_PUBLICATION_MIN_LINK_DENSITY_PERCENT = '50';
    const manager = {
      query: jest
        .fn()
        .mockResolvedValue([{ zoneCount: 100, communeLinkCount: 1000 }]),
    };
    const service = new ZonePublicationService({} as any);

    try {
      await expect(
        (service as any).assertPlausibleSnapshot(manager, {
          zoneCount: 100,
          communeLinkCount: 100,
        }),
      ).rejects.toThrow('commune-link density dropped');
      await expect(
        (service as any).assertPlausibleSnapshot(manager, {
          zoneCount: 100,
          communeLinkCount: 0,
        }),
      ).rejects.toThrow('must contain commune associations');
    } finally {
      if (previous === undefined) {
        delete process.env.ZONE_PUBLICATION_MIN_LINK_DENSITY_PERCENT;
      } else {
        process.env.ZONE_PUBLICATION_MIN_LINK_DENSITY_PERCENT = previous;
      }
    }
  });

  it('allows a large seasonal volume drop when link density remains coherent', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValue([{ zoneCount: 100, communeLinkCount: 1000 }]),
    };
    const service = new ZonePublicationService({} as any);

    await expect(
      (service as any).assertPlausibleSnapshot(manager, {
        zoneCount: 10,
        communeLinkCount: 100,
      }),
    ).resolves.toBeUndefined();
  });

  it('allows an empty snapshot only when no published restriction exists', async () => {
    const service = new ZonePublicationService({} as any);
    const noPublishedRestriction = {
      query: jest.fn().mockResolvedValue([{ hasPublishedArrete: false }]),
    };
    const publishedRestriction = {
      query: jest.fn().mockResolvedValue([{ hasPublishedArrete: true }]),
    };

    await expect(
      (service as any).assertPlausibleSnapshot(noPublishedRestriction, {
        zoneCount: 0,
        communeLinkCount: 0,
      }),
    ).resolves.toBeUndefined();
    await expect(
      (service as any).assertPlausibleSnapshot(publishedRestriction, {
        zoneCount: 0,
        communeLinkCount: 0,
      }),
    ).rejects.toThrow('forbidden while published restrictions exist');
  });

  it('retries serialization failures with a bounded attempt count', async () => {
    const service = new ZonePublicationService({} as any);
    const serializationFailure = Object.assign(
      new Error('serialization failure'),
      { code: '40001' },
    );
    const markCandidate = jest
      .spyOn(service, 'markCandidate')
      .mockRejectedValueOnce(serializationFailure)
      .mockResolvedValueOnce(true);

    await expect(
      (service as any).markCandidateWithRetry('publication', 3, 0),
    ).resolves.toBe(true);
    expect(markCandidate).toHaveBeenCalledTimes(2);

    markCandidate.mockReset().mockRejectedValue(serializationFailure);
    await expect(
      (service as any).markCandidateWithRetry('publication', 3, 0),
    ).rejects.toBe(serializationFailure);
    expect(markCandidate).toHaveBeenCalledTimes(3);
  });

  it('fails a validated snapshot immediately when candidacy cannot be recorded', async () => {
    const dataSource = { query: jest.fn().mockResolvedValue([]) };
    const service = new ZonePublicationService(dataSource as any);

    await (service as any).failValidatedPublication(
      'publication',
      new Error('deadlock'),
    );

    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining(`"status" = 'failed'`),
      ['publication', 'deadlock'],
    );
    expect(dataSource.query.mock.calls[0][0]).toContain(
      `"status" = 'validated'`,
    );
  });

  it('does not leave a validated snapshot behind after candidacy retries are exhausted', async () => {
    const manager = {
      query: jest.fn().mockResolvedValue([{ id: 'publication' }]),
    };
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    };
    const service = new ZonePublicationService(dataSource as any);
    jest
      .spyOn(service as any, 'verifyPublicArtifacts')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'assertCurrentSourceRevision')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'insertBuildingPublication')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'loadSourceZones')
      .mockResolvedValue([sourceZone()]);
    jest.spyOn(service as any, 'loadSourceUsages').mockResolvedValue([]);
    jest
      .spyOn(service as any, 'insertSnapshotZones')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'insertComputedCommuneLinks')
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, 'validateSnapshot').mockResolvedValue({
      zoneCount: 1,
      communeLinkCount: 1,
    });
    jest
      .spyOn(service as any, 'assertPlausibleSnapshot')
      .mockResolvedValue(undefined);
    const serializationFailure = Object.assign(
      new Error('serialization failure'),
      { driverError: { code: '40001' } },
    );
    const markCandidate = jest
      .spyOn(service, 'markCandidate')
      .mockRejectedValue(serializationFailure);
    const failValidated = jest
      .spyOn(service as any, 'failValidatedPublication')
      .mockResolvedValue(undefined);

    await expect(
      service.buildCandidateFromCurrentComputed({
        sourceRevision: '11',
        sourceComputedAt: new Date('2026-07-31T12:00:00Z'),
        artifactZoneCount: 1,
        geojsonUrl: 'https://example.test/zones-hash.geojson',
        geojsonChecksum: GEOJSON_CHECKSUM,
        pmtilesUrl: 'https://example.test/zones-hash.pmtiles',
        pmtilesChecksum: PMTILES_CHECKSUM,
      }),
    ).rejects.toBe(serializationFailure);

    expect(markCandidate).toHaveBeenCalledTimes(3);
    expect(failValidated).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      serializationFailure,
    );
  });

  it('enables raw volume guards only when explicitly configured', async () => {
    const previous = process.env.ZONE_PUBLICATION_MIN_ZONE_COUNT_PERCENT;
    process.env.ZONE_PUBLICATION_MIN_ZONE_COUNT_PERCENT = '50';
    const manager = {
      query: jest
        .fn()
        .mockResolvedValue([{ zoneCount: 100, communeLinkCount: 1000 }]),
    };
    const service = new ZonePublicationService({} as any);

    try {
      await expect(
        (service as any).assertPlausibleSnapshot(manager, {
          zoneCount: 10,
          communeLinkCount: 100,
        }),
      ).rejects.toThrow('zone count dropped');
    } finally {
      if (previous === undefined) {
        delete process.env.ZONE_PUBLICATION_MIN_ZONE_COUNT_PERCENT;
      } else {
        process.env.ZONE_PUBLICATION_MIN_ZONE_COUNT_PERCENT = previous;
      }
    }
  });

  it('validates a complete snapshot before exposing it as candidate', async () => {
    const manager = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM "zone_publication_source_state"')) {
          return [{ revision: '11' }];
        }
        if (sql.includes('FROM "zone_alerte_computed" z')) {
          return [sourceZone({ restrictionId: null, arreteId: null })];
        }
        if (sql.includes('INSERT INTO "zone_publication_zone"')) {
          return [{ id: '100' }];
        }
        if (
          sql.includes('SELECT COUNT(*)::integer AS "count"') &&
          sql.includes('FROM "zone_publication_zone"')
        ) {
          return [{ count: 0 }];
        }
        if (sql.includes('WITH expected AS MATERIALIZED')) {
          return [{ missingCount: 0, extraCount: 0 }];
        }
        if (sql.includes('AS "zoneCount"')) {
          return [{ zoneCount: 1, communeLinkCount: 1 }];
        }
        if (sql.includes(`SET "status" = 'validated'`)) {
          return [{ id: 'publication' }];
        }
        return [];
      }),
    };
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
      query: jest.fn().mockResolvedValue([]),
    };
    const service = new ZonePublicationService(dataSource as any);
    const markCandidate = jest
      .spyOn(service, 'markCandidate')
      .mockResolvedValue(true);

    const publicationId = await service.buildCandidateFromCurrentComputed({
      sourceRevision: '11',
      sourceComputedAt: new Date('2026-07-31T12:00:00Z'),
      artifactZoneCount: 1,
      geojsonUrl: 'https://example.test/zones-hash.geojson',
      geojsonChecksum: GEOJSON_CHECKSUM,
      pmtilesUrl: 'https://example.test/zones-hash.pmtiles',
      pmtilesChecksum: PMTILES_CHECKSUM,
    });

    expect(publicationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(markCandidate).toHaveBeenCalledWith(publicationId);
    expect(
      manager.query.mock.calls.some(([sql]) =>
        sql.includes(`SET "status" = 'validated'`),
      ),
    ).toBe(true);
  });

  it('rejects a snapshot whose zone count differs from the immutable artifacts', async () => {
    const manager = { query: jest.fn() };
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
      query: jest.fn().mockResolvedValue([]),
    };
    const service = new ZonePublicationService(dataSource as any);
    jest
      .spyOn(service as any, 'assertCurrentSourceRevision')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'insertBuildingPublication')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'loadSourceZones')
      .mockResolvedValue([sourceZone()]);
    jest.spyOn(service as any, 'loadSourceUsages').mockResolvedValue([]);
    jest
      .spyOn(service as any, 'insertSnapshotZones')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'insertComputedCommuneLinks')
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, 'validateSnapshot').mockResolvedValue({
      zoneCount: 1,
      communeLinkCount: 1,
    });
    const markCandidate = jest.spyOn(service, 'markCandidate');

    await expect(
      service.buildCandidateFromCurrentComputed({
        sourceRevision: '11',
        sourceComputedAt: new Date('2026-07-31T12:00:00Z'),
        artifactZoneCount: 2,
        geojsonUrl: 'https://example.test/zones-hash.geojson',
        geojsonChecksum: GEOJSON_CHECKSUM,
        pmtilesUrl: 'https://example.test/zones-hash.pmtiles',
        pmtilesChecksum: PMTILES_CHECKSUM,
      }),
    ).rejects.toThrow(
      'Zone publication artifact contains 2 zones but snapshot contains 1',
    );
    expect(markCandidate).not.toHaveBeenCalled();
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining(`'failed'`),
      expect.any(Array),
    );
  });

  it('checks both immutable artifacts anonymously before opening a build transaction', async () => {
    const dataSource = {
      transaction: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    };
    const service = new ZonePublicationService(dataSource as any);
    fetchSpy.mockImplementationOnce(
      async () =>
        ({
          status: 200,
          body: null,
          arrayBuffer: async () => GEOJSON_ARTIFACT,
        }) as unknown as Promise<Response>,
    );
    fetchSpy.mockImplementationOnce(
      async () =>
        ({
          status: 403,
          body: null,
          arrayBuffer: async () => Buffer.alloc(0),
        }) as unknown as Promise<Response>,
    );

    await expect(
      service.buildCandidateFromCurrentComputed({
        sourceRevision: '9',
        sourceComputedAt: new Date('2026-07-31T12:00:00Z'),
        artifactZoneCount: 0,
        geojsonUrl: 'https://example.test/zones-hash.geojson',
        geojsonChecksum: GEOJSON_CHECKSUM,
        pmtilesUrl: 'https://example.test/zones-hash.pmtiles',
        pmtilesChecksum: PMTILES_CHECKSUM,
      }),
    ).rejects.toThrow('PMTiles publication artifact returned HTTP 403');
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        method: 'GET',
        redirect: 'follow',
      }),
    );
    expect(fetchSpy.mock.calls[1][1]).not.toHaveProperty('headers.Range');
  });

  it('rejects a remotely truncated artifact even when its prefix is valid', async () => {
    const dataSource = {
      transaction: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    };
    const service = new ZonePublicationService(dataSource as any);
    fetchSpy.mockImplementation(async (url) => {
      const content = String(url).endsWith('.pmtiles')
        ? PMTILES_ARTIFACT.subarray(0, 7)
        : GEOJSON_ARTIFACT;
      return new Response(content, { status: 200 });
    });

    await expect(
      service.buildCandidateFromCurrentComputed({
        sourceRevision: '9',
        sourceComputedAt: new Date('2026-07-31T12:00:00Z'),
        artifactZoneCount: 0,
        geojsonUrl: 'https://example.test/zones-hash.geojson',
        geojsonChecksum: GEOJSON_CHECKSUM,
        pmtilesUrl: 'https://example.test/zones-hash.pmtiles',
        pmtilesChecksum: PMTILES_CHECKSUM,
      }),
    ).rejects.toThrow('PMTiles publication artifact checksum is invalid');
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects a checksum-valid PMTiles artifact with an invalid v3 header', async () => {
    const malformedPmtiles = Buffer.from('PMTiles');
    const malformedChecksum = createHash('sha256')
      .update(malformedPmtiles)
      .digest('hex');
    const dataSource = {
      transaction: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    };
    const service = new ZonePublicationService(dataSource as any);
    fetchSpy.mockImplementation(async (url) => {
      const content = String(url).endsWith('.pmtiles')
        ? malformedPmtiles
        : GEOJSON_ARTIFACT;
      return new Response(content, { status: 200 });
    });

    await expect(
      service.buildCandidateFromCurrentComputed({
        sourceRevision: '9',
        sourceComputedAt: new Date('2026-07-31T12:00:00Z'),
        artifactZoneCount: 0,
        geojsonUrl: 'https://example.test/zones-hash.geojson',
        geojsonChecksum: GEOJSON_CHECKSUM,
        pmtilesUrl: 'https://example.test/zones-hash.pmtiles',
        pmtilesChecksum: malformedChecksum,
      }),
    ).rejects.toThrow('PMTiles publication artifact header is invalid');
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects an empty national snapshot when a published restriction exists', async () => {
    const manager = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM "zone_publication_source_state"')) {
          return [{ revision: '9' }];
        }
        if (sql.includes('FROM "zone_alerte_computed" z')) {
          return [];
        }
        if (
          sql.includes('SELECT COUNT(*)::integer AS "count"') &&
          sql.includes('FROM "zone_publication_zone"')
        ) {
          return [{ count: 0 }];
        }
        if (sql.includes('WITH expected AS MATERIALIZED')) {
          return [{ missingCount: 0, extraCount: 0 }];
        }
        if (sql.includes('AS "zoneCount"')) {
          return [{ zoneCount: 0, communeLinkCount: 0 }];
        }
        if (sql.includes('AS "hasPublishedArrete"')) {
          return [{ hasPublishedArrete: true }];
        }
        return [];
      }),
    };
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
      query: jest.fn().mockResolvedValue([]),
    };
    const service = new ZonePublicationService(dataSource as any);
    const markCandidate = jest.spyOn(service, 'markCandidate');

    await expect(
      service.buildCandidateFromCurrentComputed({
        sourceRevision: '9',
        sourceComputedAt: new Date('2026-07-31T12:00:00Z'),
        artifactZoneCount: 0,
        geojsonUrl: 'https://example.test/zones-hash.geojson',
        geojsonChecksum: GEOJSON_CHECKSUM,
        pmtilesUrl: 'https://example.test/zones-hash.pmtiles',
        pmtilesChecksum: PMTILES_CHECKSUM,
      }),
    ).rejects.toThrow('forbidden while published restrictions exist');
    expect(markCandidate).not.toHaveBeenCalled();
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining(`'failed'`),
      expect.any(Array),
    );
  });

  it('publishes an empty national snapshot when no published restriction exists', async () => {
    const manager = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM "zone_publication_source_state"')) {
          return [{ revision: '9' }];
        }
        if (sql.includes('FROM "zone_alerte_computed" z')) {
          return [];
        }
        if (
          sql.includes('SELECT COUNT(*)::integer AS "count"') &&
          sql.includes('FROM "zone_publication_zone"')
        ) {
          return [{ count: 0 }];
        }
        if (sql.includes('WITH expected AS MATERIALIZED')) {
          return [{ missingCount: 0, extraCount: 0 }];
        }
        if (sql.includes('AS "zoneCount"')) {
          return [{ zoneCount: 0, communeLinkCount: 0 }];
        }
        if (sql.includes('AS "hasPublishedArrete"')) {
          return [{ hasPublishedArrete: false }];
        }
        if (sql.includes(`SET "status" = 'validated'`)) {
          return [{ id: 'publication' }];
        }
        return [];
      }),
    };
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
      query: jest.fn().mockResolvedValue([]),
    };
    const service = new ZonePublicationService(dataSource as any);
    const markCandidate = jest
      .spyOn(service, 'markCandidate')
      .mockResolvedValue(true);

    const publicationId = await service.buildCandidateFromCurrentComputed({
      sourceRevision: '9',
      sourceComputedAt: new Date('2026-07-31T12:00:00Z'),
      artifactZoneCount: 0,
      geojsonUrl: 'https://example.test/zones-hash.geojson',
      geojsonChecksum: GEOJSON_CHECKSUM,
      pmtilesUrl: 'https://example.test/zones-hash.pmtiles',
      pmtilesChecksum: PMTILES_CHECKSUM,
    });

    expect(markCandidate).toHaveBeenCalledWith(publicationId);
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('AS "hasPublishedArrete"'),
    );
  });
});
