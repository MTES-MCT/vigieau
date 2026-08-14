import {
  buildZonePublicPayload,
  computeZonePublicationRetryBackoffSeconds,
  ZonePublicationService,
  ZoneSourceRow,
  ZoneUsageRow,
} from './zone_publication.service';
import { createHash } from 'node:crypto';
import { ZONE_PUBLICATION_MATERIALIZATION_VERSION } from './zone_publication.config';

function geojsonArtifact(featureCount: number): Buffer<ArrayBuffer> {
  return Buffer.from(
    JSON.stringify({
      type: 'FeatureCollection',
      features: Array.from({ length: featureCount }, (_, index) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [index, index] },
        properties: { id: index + 1 },
      })),
    }),
  );
}

const GEOJSON_ARTIFACT = geojsonArtifact(1);
const EMPTY_GEOJSON_ARTIFACT = geojsonArtifact(0);
const PMTILES_ARTIFACT = (() => {
  const header = Buffer.alloc(129);
  header.write('PMTiles', 0, 'ascii');
  header.writeUInt8(3, 7);
  header.writeBigUInt64LE(127n, 8);
  header.writeBigUInt64LE(1n, 16);
  header.writeBigUInt64LE(128n, 24);
  header.writeBigUInt64LE(0n, 32);
  header.writeBigUInt64LE(128n, 40);
  header.writeBigUInt64LE(0n, 48);
  header.writeBigUInt64LE(128n, 56);
  header.writeBigUInt64LE(1n, 64);
  header.writeBigUInt64LE(1n, 72);
  header.writeBigUInt64LE(1n, 80);
  header.writeBigUInt64LE(1n, 88);
  header.writeUInt8(1, 99);
  return header;
})();
const GEOJSON_CHECKSUM = createHash('sha256')
  .update(GEOJSON_ARTIFACT)
  .digest('hex');
const EMPTY_GEOJSON_CHECKSUM = createHash('sha256')
  .update(EMPTY_GEOJSON_ARTIFACT)
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

  it('unwraps the PostgreSQL DML result when bumping the source revision', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([[{ revision: '12' }], 1]),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(service.bumpSourceRevision()).resolves.toBe('12');
  });

  it('reuses only a complete publication from the requested Paris civil day and revision', async () => {
    const publication = {
      publicationId: 'publication-1',
      sourceRevision: '42',
    };
    const dataSource = {
      query: jest.fn(
        async (_sql: string, [sourceRevision, version, scheduledFor]) =>
          sourceRevision === '42' &&
          version === ZONE_PUBLICATION_MATERIALIZATION_VERSION &&
          scheduledFor === '2026-08-02'
            ? [publication]
            : [],
      ),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(
      service.findReusableDailyPublication({
        scheduledFor: '2026-08-02',
        sourceRevision: '42',
      }),
    ).resolves.toEqual(publication);
    await expect(
      service.findReusableDailyPublication({
        scheduledFor: '2026-08-01',
        sourceRevision: '42',
      }),
    ).resolves.toBeNull();
    await expect(
      service.findReusableDailyPublication({
        scheduledFor: '2026-08-02',
        sourceRevision: '41',
      }),
    ).resolves.toBeNull();

    const sql = dataSource.query.mock.calls[0][0];
    expect(sql).toContain('publication."status" = \'candidate\'');
    expect(sql).toContain('publication."status" = \'active\'');
    expect(sql).toContain('publication."status" = \'validated\'');
    expect(sql).toContain('publication."materializationVersion" = $2');
    expect(sql).toContain('publication."sourceRevision" = source."revision"');
    expect(sql).toContain("AT TIME ZONE 'Europe/Paris'");
    expect(sql).toContain('publication."validatedAt" IS NOT NULL');
    expect(sql).toContain('FROM "zone_publication_aggregate" aggregate');
  });

  it('rejects malformed daily publication reuse identities before querying', async () => {
    const dataSource = { query: jest.fn() };
    const service = new ZonePublicationService(dataSource as any);

    await expect(
      service.findReusableDailyPublication({
        scheduledFor: '02/08/2026',
        sourceRevision: '42',
      }),
    ).rejects.toThrow('Invalid daily zone publication date');
    await expect(
      service.findReusableDailyPublication({
        scheduledFor: '2026-08-02',
        sourceRevision: '42 OR 1=1',
      }),
    ).rejects.toThrow('Invalid daily zone publication source revision');
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('opens the daily gate only for the fully promoted active publication', async () => {
    const sourceComputedAt = new Date('2026-08-01T08:00:00Z');
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        {
          publicationId: 'publication-1',
          sourceRevision: '42',
          sourceComputedAt,
          geojsonUrl: 'https://example.test/zones.geojson',
          geojsonChecksum: 'a'.repeat(64),
          pmtilesUrl: 'https://example.test/zones.pmtiles',
          pmtilesChecksum: 'b'.repeat(64),
        },
      ]),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(
      service.getActivePublicationGate('2026-08-01'),
    ).resolves.toEqual(
      expect.objectContaining({
        publicationId: 'publication-1',
        sourceRevision: '42',
        sourceComputedAt: sourceComputedAt.toISOString(),
      }),
    );
    const sql = dataSource.query.mock.calls[0][0];
    expect(sql).toContain('publication."status" = \'active\'');
    expect(sql).toContain('publication."sourceRevision" = source."revision"');
    expect(sql).toContain('publication."materializationVersion" = $2');
    expect(sql).toContain('publication."legacyPromotedAt" IS NOT NULL');
    expect(sql).toContain('publication."dataGouvPromotedAt" IS NOT NULL');
    expect(sql).toContain("AT TIME ZONE 'Europe/Paris'");
    expect(dataSource.query).toHaveBeenCalledWith(expect.any(String), [
      '2026-08-01',
      ZONE_PUBLICATION_MATERIALIZATION_VERSION,
    ]);
  });

  it('keeps the daily gate closed without a matching publication', async () => {
    const service = new ZonePublicationService({
      query: jest.fn().mockResolvedValue([]),
    } as any);

    await expect(
      service.getActivePublicationGate('2026-08-01'),
    ).resolves.toBeNull();
  });

  it('requests recomputation only when neither active nor candidate matches', async () => {
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValueOnce([
          {
            sourceRevision: '10',
            activeRevision: '9',
            activeMaterializationVersion:
              ZONE_PUBLICATION_MATERIALIZATION_VERSION,
            candidateRevision: null,
            candidateMaterializationVersion: null,
            failureCount: 0,
          },
        ])
        .mockResolvedValueOnce([
          {
            sourceRevision: '10',
            activeRevision: '9',
            activeMaterializationVersion:
              ZONE_PUBLICATION_MATERIALIZATION_VERSION,
            candidateRevision: '10',
            candidateMaterializationVersion:
              ZONE_PUBLICATION_MATERIALIZATION_VERSION,
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

  it('keeps automatic recomputation paused after a persisted rollback', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        {
          sourceRevision: '10',
          activeRevision: '9',
          activeMaterializationVersion:
            ZONE_PUBLICATION_MATERIALIZATION_VERSION,
          candidateRevision: null,
          candidateMaterializationVersion: null,
          automaticPublishingPaused: true,
          failureCount: 0,
          recentInProgress: false,
        },
      ]),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(service.isRecomputeRequired()).resolves.toBe(false);
    expect(dataSource.query.mock.calls[0][0]).toContain(
      'state."automaticPublishingPaused"',
    );
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
          activeMaterializationVersion:
            ZONE_PUBLICATION_MATERIALIZATION_VERSION,
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
    expect(dataSource.query).toHaveBeenCalledWith(expect.any(String), [
      4500,
      ZONE_PUBLICATION_MATERIALIZATION_VERSION,
    ]);
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
          activeMaterializationVersion:
            ZONE_PUBLICATION_MATERIALIZATION_VERSION,
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
          activeMaterializationVersion:
            ZONE_PUBLICATION_MATERIALIZATION_VERSION,
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
          activeMaterializationVersion:
            ZONE_PUBLICATION_MATERIALIZATION_VERSION,
          candidateRevision: null,
          candidateMaterializationVersion: null,
          failureCount: 0,
          recentInProgress: true,
        },
      ]),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(service.isRecomputeRequired()).resolves.toBe(false);
    expect(dataSource.query).toHaveBeenCalledWith(expect.any(String), [
      4500,
      ZONE_PUBLICATION_MATERIALIZATION_VERSION,
    ]);
    const sql = dataSource.query.mock.calls[0][0] as string;
    expect(sql).toContain(
      `(in_progress."sourceComputedAt" AT TIME ZONE 'Europe/Paris')::date`,
    );
    expect(sql).toContain('SELECT MAX(latest_daily."scheduledFor")');
  });

  it('does not rebuild while the latest historic barrier is pending', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        {
          sourceRevision: '10',
          activeRevision: '9',
          activeMaterializationVersion:
            ZONE_PUBLICATION_MATERIALIZATION_VERSION,
          candidateRevision: null,
          candidateMaterializationVersion: null,
          failureCount: 0,
          recentInProgress: false,
          statisticsBarrierPending: true,
        },
      ]),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(service.isRecomputeRequired()).resolves.toBe(false);

    const sql = dataSource.query.mock.calls[0][0] as string;
    expect(sql).toContain(`historic_run."status" IS DISTINCT FROM 'succeeded'`);
    expect(sql).toContain('statistic_state."historicDirtyFrom" IS NOT NULL');
    expect(sql).toContain('\'sourceRevision\', source."revision"::text');
    expect(sql).toContain("'materializationVersion', $2::integer");
    expect(sql).toContain('ORDER BY daily_run."scheduledFor" DESC');
  });

  it('ignores an older failed barrier when the latest daily run is certified', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        {
          sourceRevision: '10',
          activeRevision: '9',
          activeMaterializationVersion:
            ZONE_PUBLICATION_MATERIALIZATION_VERSION,
          candidateRevision: null,
          candidateMaterializationVersion: null,
          failureCount: 0,
          recentInProgress: false,
          statisticsBarrierPending: false,
        },
      ]),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(service.isRecomputeRequired()).resolves.toBe(true);
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
              materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
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

  it('does not replace a prepared rollback candidate with a concurrent build', async () => {
    const executed: Array<{ sql: string; params?: unknown[] }> = [];
    const manager = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        executed.push({ sql, params });
        if (sql.includes('FROM "zone_publication_source_state"')) {
          return [{ revision: '10' }];
        }
        if (sql.includes('FROM "zone_publication_state"')) {
          return [
            {
              activePublicationId: 'active',
              candidatePublicationId: 'rollback-target',
              candidateStatus: 'retired',
              automaticPublishingPaused: true,
            },
          ];
        }
        if (
          sql.includes('FROM "zone_publication"') &&
          sql.includes('FOR UPDATE')
        ) {
          return [
            {
              id: 'new-build',
              status: 'validated',
              sourceRevision: '10',
              materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
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

    await expect(service.markCandidate('new-build')).resolves.toBe(false);
    expect(
      executed.some(
        ({ sql, params }) =>
          sql.includes(`SET "status" = 'superseded'`) &&
          params?.[0] === 'new-build',
      ),
    ).toBe(true);
    expect(
      executed.some(
        ({ sql, params }) =>
          sql.includes('UPDATE "zone_publication_state"') ||
          params?.[0] === 'rollback-target',
      ),
    ).toBe(false);
  });

  it('keeps a validated publication private until the exact historic cursor epoch is certified', async () => {
    const manager = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM "zone_publication_source_state"')) {
          return [{ revision: '10' }];
        }
        if (sql.includes('FROM "zone_publication_state"')) {
          return [
            {
              activePublicationId: 'active',
              candidatePublicationId: null,
              automaticPublishingPaused: false,
            },
          ];
        }
        if (
          sql.includes('SELECT * FROM "zone_publication"') &&
          sql.includes('FOR UPDATE')
        ) {
          return [
            {
              id: 'validated',
              status: 'validated',
              sourceRevision: '10',
              materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
            },
          ];
        }
        return [];
      }),
    };
    const service = new ZonePublicationService({
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    } as any);

    await expect(service.markCandidate('validated')).rejects.toThrow(
      'waiting for certified current statistics or historic catch-up',
    );
    expect(
      manager.query.mock.calls.some(([sql]) =>
        sql.includes(`SET "status" = 'candidate'`),
      ),
    ).toBe(false);

    const certificationSql = manager.query.mock.calls.find(([sql]) =>
      sql.includes('certified_publication'),
    )?.[0];
    expect(certificationSql).toContain('snapshot."status" = \'ready\'');
    expect(certificationSql).toContain('daily_run."status" = \'succeeded\'');
    expect(certificationSql).toContain('historic_run."status" = \'succeeded\'');
    expect(certificationSql).toContain(
      'statistic_state."historicDirtyFrom" IS NULL',
    );
    expect(certificationSql).toContain(
      `'historicMapCursor', historic_cursor."computeMapDate"::text`,
    );
    expect(certificationSql).toContain(
      `'historicStatsCursor', historic_cursor."computeStatsDate"::text`,
    );
    expect(certificationSql).toContain(
      `'historicMapGeneration', historic_cursor."computeMapGeneration"::text`,
    );
    expect(certificationSql).toContain(
      `'historicStatsGeneration', historic_cursor."computeStatsGeneration"::text`,
    );
  });

  it('marks a validated publication candidate atomically after certification', async () => {
    const executed: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string) => {
        executed.push(sql);
        if (sql.includes('FROM "zone_publication_source_state"')) {
          return [{ revision: '10' }];
        }
        if (sql.includes('FROM "zone_publication_state"')) {
          return [
            {
              activePublicationId: 'active',
              candidatePublicationId: null,
              automaticPublishingPaused: false,
            },
          ];
        }
        if (
          sql.includes('SELECT * FROM "zone_publication"') &&
          sql.includes('FOR UPDATE')
        ) {
          return [
            {
              id: 'validated',
              status: 'validated',
              sourceRevision: '10',
              materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
            },
          ];
        }
        if (sql.includes('certified_publication')) {
          return [{ snapshotDate: '2026-08-01' }];
        }
        if (sql.includes(`SET "status" = 'candidate'`)) {
          return [[{ id: 'validated' }], 1];
        }
        return [];
      }),
    };
    const service = new ZonePublicationService({
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    } as any);

    await expect(
      service.markCandidateAfterStatistics('validated'),
    ).resolves.toBe(true);

    const certifiedIndex = executed.findIndex((sql) =>
      sql.includes('certified_publication'),
    );
    const candidateIndex = executed.findIndex((sql) =>
      sql.includes(`SET "status" = 'candidate'`),
    );
    const pointerIndex = executed.findIndex((sql) =>
      sql.includes('SET "candidatePublicationId" = $1'),
    );
    expect(certifiedIndex).toBeGreaterThan(-1);
    expect(candidateIndex).toBeGreaterThan(certifiedIndex);
    expect(pointerIndex).toBeGreaterThan(candidateIndex);
  });

  it('recovers a rebuilt validated publication after the persisted candidate failed', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([{ id: 'rebuilt-validated' }]),
    };
    const service = new ZonePublicationService(dataSource as any);
    const markCandidate = jest
      .spyOn(service, 'markCandidateAfterStatistics')
      .mockResolvedValue(true);

    await expect(
      service.promoteCertifiedPublicationIfAvailable({
        scheduledFor: '2026-08-01',
        sourceRevision: '10',
        preferredPublicationId: 'dcf24878-0000-4000-8000-000000000000',
      }),
    ).resolves.toBe(true);
    expect(markCandidate).toHaveBeenCalledWith('rebuilt-validated');
    expect(dataSource.query).toHaveBeenCalledWith(expect.any(String), [
      ZONE_PUBLICATION_MATERIALIZATION_VERSION,
      '2026-08-01',
      '10',
      'dcf24878-0000-4000-8000-000000000000',
    ]);
    const sql = dataSource.query.mock.calls[0][0] as string;
    expect(sql).toContain('daily_run."scheduledFor" =');
    expect(sql).toContain(
      `(publication."sourceComputedAt" AT TIME ZONE 'Europe/Paris')::date`,
    );
    expect(sql).toContain(`failed_publication."status" = 'failed'`);
    expect(sql).toContain('failed_publication."sourceRevision"');
    expect(sql).toContain('failed_publication."materializationVersion"');
    expect(sql).toContain('failed_publication."sourceComputedAt"');
    expect(sql).toContain("AT TIME ZONE 'Europe/Paris'");
    expect(sql).toContain(')::date = daily_run."scheduledFor"');
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
              materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
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
    expect(
      executed.some((sql) => sql.includes(`SET "status" = 'retired'`)),
    ).toBe(false);
  });

  it('expires an unreadable candidate without changing the active publication', async () => {
    const executed: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string) => {
        executed.push(sql);
        if (sql.includes(`SET "status" = 'failed'`)) {
          return [[{ id: 'candidate' }], 1];
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
              materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
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
      executed.some((sql) => sql.includes(`SET "status" = 'active'`)),
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
              materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
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
          return [[{ id: 'candidate' }], 1];
        }
        if (
          sql.includes('JOIN "statistic_commune_snapshot" snapshot') &&
          sql.includes('FOR UPDATE OF snapshot')
        ) {
          return [{ snapshotDate: '2026-08-02' }];
        }
        if (
          sql.includes('UPDATE "statistic_commune_snapshot"') &&
          sql.includes('RETURNING "snapshotDate"')
        ) {
          return [[{ snapshotDate: '2026-08-02' }], 1];
        }
        if (sql.includes('UPDATE "statistic_publication_state"')) {
          return [[{ revision: '1' }], 1];
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
              materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
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
    const readySnapshotIndex = executed.findIndex((sql) =>
      sql.includes('JOIN "statistic_commune_snapshot" snapshot'),
    );
    const snapshotCompletionIndex = executed.findIndex(
      (sql) =>
        sql.includes('UPDATE "statistic_commune_snapshot"') &&
        sql.includes('RETURNING "snapshotDate"'),
    );
    const statisticPublicationIndex = executed.findIndex((sql) =>
      sql.includes('UPDATE "statistic_publication_state"'),
    );
    const otherScopesCompletionIndex = executed.findIndex(
      (sql) =>
        sql.includes('UPDATE "statistic_commune_snapshot"') &&
        sql.includes('"scope" <> \'national\''),
    );
    const bootstrapDeletionIndex = executed.findIndex(
      (sql) =>
        sql.includes('DELETE FROM "statistic_commune_snapshot"') &&
        sql.includes('"scope" = \'bootstrap\''),
    );
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
    expect(readySnapshotIndex).toBeGreaterThan(promotionLockIndex);
    expect(snapshotCompletionIndex).toBeGreaterThan(readySnapshotIndex);
    expect(otherScopesCompletionIndex).toBeGreaterThan(snapshotCompletionIndex);
    expect(bootstrapDeletionIndex).toBeGreaterThan(otherScopesCompletionIndex);
    expect(statisticPublicationIndex).toBeGreaterThan(snapshotCompletionIndex);
    expect(statisticPublicationIndex).toBeGreaterThan(bootstrapDeletionIndex);
    expect(statisticPublicationIndex).toBeLessThan(retiredIndex);
    expect(promotionLockIndex).toBeLessThan(retiredIndex);
    expect(promotionLockIndex).toBeLessThan(activeIndex);
    expect(promotionLockIndex).toBeLessThan(stateSwitchIndex);
    const readySnapshotSql = executed[readySnapshotIndex];
    expect(readySnapshotSql).toContain("AT TIME ZONE 'UTC'");
    expect(readySnapshotSql).toContain('snapshot."scope" = \'national\'');
    expect(readySnapshotSql).toContain('snapshot."status" = \'ready\'');
    expect(readySnapshotSql).toContain(
      'snapshot."sourceRevision" = publication."sourceRevision"',
    );
    expect(readySnapshotSql).toContain("'compute:national-daily'");
    expect(readySnapshotSql).toContain("'compute:historic-catchup'");
    expect(readySnapshotSql).toContain(
      `daily_run."metadata" ->> 'publicationId' =`,
    );
    expect(readySnapshotSql).toContain(
      `failed_publication."status" = 'failed'`,
    );
    expect(readySnapshotSql).toContain(`failed_publication."sourceRevision" =`);
    expect(readySnapshotSql).toContain(
      `failed_publication."materializationVersion" =`,
    );
    expect(readySnapshotSql).toContain(`)::date = daily_run."scheduledFor"`);
    expect(readySnapshotSql).not.toContain(
      `'publicationId', publication."id"::text`,
    );
    expect(readySnapshotSql).toContain(
      `'sourceRevision', publication."sourceRevision"::text`,
    );
    expect(readySnapshotSql).toContain(
      `'materializationVersion', publication."materializationVersion"`,
    );
    expect(readySnapshotSql).toContain(
      `historic_run."scheduledFor" = daily_run."scheduledFor"`,
    );
    expect(readySnapshotSql).toContain(
      `'historicMapCursor', historic_cursor."computeMapDate"::text`,
    );
    expect(readySnapshotSql).toContain(
      `'historicStatsCursor', historic_cursor."computeStatsDate"::text`,
    );
    expect(readySnapshotSql).toContain(
      `'historicMapGeneration', historic_cursor."computeMapGeneration"::text`,
    );
    expect(readySnapshotSql).toContain(
      `'historicStatsGeneration', historic_cursor."computeStatsGeneration"::text`,
    );
    expect(readySnapshotSql).toContain(`running_daily."status" = 'running'`);
    expect(readySnapshotSql).not.toContain(
      `daily_run."scheduledFor" =
                        (publication."sourceComputedAt" AT TIME ZONE 'UTC')::date`,
    );
    expect(readySnapshotSql).toContain(
      'statistic_state."historicDirtyFrom" IS NULL',
    );
    expect(readySnapshotSql).toContain(
      'statistic_state."historicPublishedThrough" >=',
    );
    expect(readySnapshotSql).toContain('historic_cursor."computeMapDate" >=');
    expect(readySnapshotSql).toContain('historic_cursor."computeStatsDate" >=');
    expect(readySnapshotSql).toContain(
      'statistic_state."currentPublishedDate" IS NULL',
    );
    expect(readySnapshotSql).toContain(
      'FOR UPDATE OF snapshot, statistic_state, historic_cursor',
    );
    const runningDailyGuardStart = readySnapshotSql.indexOf(
      'FROM "external_publication_run" running_daily',
    );
    const runningDailyGuard = readySnapshotSql.slice(
      runningDailyGuardStart,
      readySnapshotSql.indexOf(
        'FROM "external_publication_run" daily_run',
        runningDailyGuardStart,
      ),
    );
    expect(runningDailyGuard).toContain(`running_daily."status" = 'running'`);
    expect(runningDailyGuard).toContain(
      'statistic_state."currentPublishedDate" IS NULL',
    );
    expect(runningDailyGuard).toContain(
      `(publication."sourceComputedAt" AT TIME ZONE 'Europe/Paris')::date`,
    );
    expect(runningDailyGuard).not.toContain('sourceRevision');
    expect(runningDailyGuard).not.toContain('materializationVersion');
    expect(executed[statisticPublicationIndex]).toContain(
      '"historicDirtyFrom" IS NULL',
    );
    expect(executed[statisticPublicationIndex]).toContain(
      '"revision" = "revision" + 1',
    );
    expect(executed[statisticPublicationIndex]).toContain(
      '"currentPublishedDate" = $1::date',
    );
    expect(executed[statisticPublicationIndex]).toContain(
      'WHEN "currentPublishedDate" IS NULL THEN $1::date - 1',
    );
  });

  it('refuses activation without the matching ready national snapshot', async () => {
    const executed: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string) => {
        executed.push(sql);
        if (sql.includes('pg_try_advisory_xact_lock')) {
          return [{ locked: true }];
        }
        if (sql.includes('JOIN "statistic_commune_snapshot" snapshot')) {
          return [];
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
              materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
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
    ).rejects.toThrow(
      'Publication candidate is waiting for certified current statistics or historic catch-up',
    );

    expect(
      executed.some((sql) => sql.includes(`SET "status" = 'retired'`)),
    ).toBe(false);
    expect(
      executed.some((sql) => sql.includes(`SET "status" = 'active'`)),
    ).toBe(false);
    expect(
      executed.some((sql) =>
        sql.includes('UPDATE "statistic_publication_state"'),
      ),
    ).toBe(false);
    expect(
      executed.some(
        (sql) =>
          sql.includes('UPDATE "zone_publication_state"') &&
          sql.includes('"activePublicationId" = $1'),
      ),
    ).toBe(false);
  });

  it('keeps rollback activation read-only while the global compute lock is busy', async () => {
    const executed: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string) => {
        executed.push(sql);
        if (sql.includes("hashtext('zone-compute-global')")) {
          return [{ locked: false }];
        }
        if (sql.includes('FROM "zone_publication_state"')) {
          return [
            {
              activePublicationId: 'active',
              candidatePublicationId: 'retired',
            },
          ];
        }
        if (
          sql.includes('FROM "zone_publication"') &&
          sql.includes('FOR UPDATE')
        ) {
          return [
            {
              id: 'retired',
              status: 'retired',
              sourceRevision: '42',
              materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
              zoneCount: 10,
              communeLinkCount: 20,
              sourceComputedAt: new Date('2026-08-01T08:00:00Z'),
            },
          ];
        }
        if (sql.includes('FROM "zone_publication_source_state"')) {
          return [{ revision: '42' }];
        }
        if (sql.includes('FROM "zone_publication_instance"')) {
          return [{ liveInstances: 2, readyInstances: 2 }];
        }
        return [];
      }),
    };
    const service = new ZonePublicationService({
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    } as any);

    await expect(
      service.activateWhenReady({ minimumReadyInstances: 2 }),
    ).resolves.toEqual({
      status: 'busy',
      publicationId: 'retired',
      liveInstances: 2,
      readyInstances: 2,
      rollback: true,
    });
    expect(
      executed.some(
        (sql) =>
          /^(?:UPDATE|DELETE|INSERT)\b/i.test(sql.trim()) ||
          sql.includes('WITH target AS MATERIALIZED'),
      ),
    ).toBe(false);
  });

  it('keeps rollback activation read-only while the historic compute lock is busy', async () => {
    const executed: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string) => {
        executed.push(sql);
        if (sql.includes("hashtext('zone-compute-global')")) {
          return [{ locked: true }];
        }
        if (sql.includes("hashtext('zone-compute-historic')")) {
          return [{ locked: false }];
        }
        if (sql.includes('FROM "zone_publication_state"')) {
          return [
            {
              activePublicationId: 'active',
              candidatePublicationId: 'retired',
            },
          ];
        }
        if (
          sql.includes('FROM "zone_publication"') &&
          sql.includes('FOR UPDATE')
        ) {
          return [
            {
              id: 'retired',
              status: 'retired',
              sourceRevision: '42',
              materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
              zoneCount: 10,
              communeLinkCount: 20,
              sourceComputedAt: new Date('2026-08-01T08:00:00Z'),
            },
          ];
        }
        if (sql.includes('FROM "zone_publication_source_state"')) {
          return [{ revision: '42' }];
        }
        if (sql.includes('FROM "zone_publication_instance"')) {
          return [{ liveInstances: 2, readyInstances: 2 }];
        }
        return [];
      }),
    };
    const service = new ZonePublicationService({
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    } as any);

    await expect(
      service.activateWhenReady({ minimumReadyInstances: 2 }),
    ).resolves.toEqual({
      status: 'busy',
      publicationId: 'retired',
      liveInstances: 2,
      readyInstances: 2,
      rollback: true,
    });
    expect(
      executed.some(
        (sql) =>
          /^(?:UPDATE|DELETE|INSERT)\b/i.test(sql.trim()) ||
          sql.includes('WITH target AS MATERIALIZED'),
      ),
    ).toBe(false);
  });

  it('blocks rollback activation while historic statistics are dirty', async () => {
    const executed: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string) => {
        executed.push(sql);
        if (sql.includes('pg_try_advisory_xact_lock')) {
          return [{ locked: true }];
        }
        if (sql.includes('FROM "statistic_publication_state"')) {
          return [
            {
              historicDirtyFrom: '2026-07-31',
              historicDirtyThrough: '2026-08-01',
            },
          ];
        }
        if (sql.includes('FROM "zone_publication_state"')) {
          return [
            {
              activePublicationId: 'active',
              candidatePublicationId: 'retired',
            },
          ];
        }
        if (
          sql.includes('FROM "zone_publication"') &&
          sql.includes('FOR UPDATE')
        ) {
          return [
            {
              id: 'retired',
              status: 'retired',
              sourceRevision: '42',
              materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
              zoneCount: 10,
              communeLinkCount: 20,
              sourceComputedAt: new Date('2026-08-01T08:00:00Z'),
            },
          ];
        }
        if (sql.includes('FROM "zone_publication_source_state"')) {
          return [{ revision: '42' }];
        }
        if (sql.includes('FROM "zone_publication_instance"')) {
          return [{ liveInstances: 2, readyInstances: 2 }];
        }
        return [];
      }),
    };
    const service = new ZonePublicationService({
      transaction: jest.fn((_isolation, callback) => callback(manager)),
    } as any);

    await expect(
      service.activateWhenReady({ minimumReadyInstances: 2 }),
    ).rejects.toThrow(
      'Rollback publication retired is blocked by dirty historic statistics',
    );
    expect(
      executed.some((sql) => sql.includes('WITH target AS MATERIALIZED')),
    ).toBe(false);
    expect(
      executed.some((sql) => sql.includes(`SET "status" = 'active'`)),
    ).toBe(false);
  });

  it.each([
    ['source revision', '41', ZONE_PUBLICATION_MATERIALIZATION_VERSION],
    ['materialization version', '42', 2],
  ])(
    'cancels a prepared rollback when its %s changed before activation',
    async (_reason, sourceRevision, materializationVersion) => {
      const executed: Array<{ sql: string; params?: unknown[] }> = [];
      const manager = {
        query: jest.fn(async (sql: string, params?: unknown[]) => {
          executed.push({ sql, params });
          if (sql.includes('pg_try_advisory_xact_lock')) {
            return [{ locked: true }];
          }
          if (sql.includes('FROM "zone_publication_state"')) {
            return [
              {
                activePublicationId: 'active',
                candidatePublicationId: 'retired',
              },
            ];
          }
          if (
            sql.includes('FROM "zone_publication"') &&
            sql.includes('FOR UPDATE')
          ) {
            return [
              {
                id: 'retired',
                status: 'retired',
                sourceRevision,
                materializationVersion,
                zoneCount: 10,
                communeLinkCount: 20,
                sourceComputedAt: new Date('2026-08-01T08:00:00Z'),
              },
            ];
          }
          if (sql.includes('FROM "zone_publication_source_state"')) {
            return [{ revision: '42' }];
          }
          if (sql.includes('FROM "zone_publication_instance"')) {
            return [{ liveInstances: 2, readyInstances: 2 }];
          }
          return [];
        }),
      };
      const service = new ZonePublicationService({
        transaction: jest.fn((_isolation, callback) => callback(manager)),
      } as any);

      await expect(
        service.activateWhenReady({ minimumReadyInstances: 2 }),
      ).resolves.toEqual({
        status: 'rollback_cancelled',
        publicationId: 'retired',
        liveInstances: 2,
        readyInstances: 2,
        rollback: true,
      });
      expect(
        executed.some(
          ({ sql, params }) =>
            sql.includes('"candidatePublicationId" = NULL') &&
            sql.includes('"candidateRequestedAt" = NULL') &&
            params?.[0] === 'retired',
        ),
      ).toBe(true);
      expect(
        executed.some(({ sql }) =>
          sql.includes('FROM "statistic_commune_snapshot"'),
        ),
      ).toBe(false);
      expect(
        executed.some(({ sql }) => sql.includes(`SET "status" = 'active'`)),
      ).toBe(false);
    },
  );

  it.each([
    [
      'has no certified national statistic snapshot',
      [],
      'Rollback publication retired has no certified national statistic snapshot',
    ],
    [
      'has an incomplete snapshot on the target timeline',
      [
        {
          snapshotDate: '2026-08-01',
          scope: 'national',
          status: 'completed',
          sourceRevision: '42',
        },
        {
          snapshotDate: '2026-07-31',
          scope: '65',
          status: 'failed',
          sourceRevision: '42',
        },
      ],
      'Rollback publication retired is blocked by 1 incomplete statistic snapshot(s) on or before 2026-08-01',
    ],
  ])(
    'blocks rollback activation when it %s',
    async (_reason, snapshots, expectedError) => {
      const executed: string[] = [];
      const manager = {
        query: jest.fn(async (sql: string) => {
          executed.push(sql);
          if (sql.includes('pg_try_advisory_xact_lock')) {
            return [{ locked: true }];
          }
          if (sql.includes('FROM "zone_publication_state"')) {
            return [
              {
                activePublicationId: 'active',
                candidatePublicationId: 'retired',
              },
            ];
          }
          if (
            sql.includes('FROM "zone_publication"') &&
            sql.includes('FOR UPDATE')
          ) {
            return [
              {
                id: 'retired',
                status: 'retired',
                sourceRevision: '42',
                materializationVersion:
                  ZONE_PUBLICATION_MATERIALIZATION_VERSION,
                zoneCount: 10,
                communeLinkCount: 20,
                sourceComputedAt: new Date('2026-08-01T08:00:00Z'),
              },
            ];
          }
          if (sql.includes('FROM "zone_publication_source_state"')) {
            return [{ revision: '42' }];
          }
          if (sql.includes('FROM "zone_publication_instance"')) {
            return [{ liveInstances: 2, readyInstances: 2 }];
          }
          if (sql.includes('FROM "statistic_publication_state"')) {
            return [{ historicDirtyFrom: null, historicDirtyThrough: null }];
          }
          if (sql.includes('FROM "statistic_commune_snapshot"')) {
            return snapshots;
          }
          return [];
        }),
      };
      const service = new ZonePublicationService({
        transaction: jest.fn((_isolation, callback) => callback(manager)),
      } as any);

      await expect(
        service.activateWhenReady({ minimumReadyInstances: 2 }),
      ).rejects.toThrow(expectedError);
      expect(
        executed.some((sql) => sql.includes('WITH target AS MATERIALIZED')),
      ).toBe(false);
      expect(
        executed.some((sql) => sql.includes(`SET "status" = 'active'`)),
      ).toBe(false);
    },
  );

  it('reactivates a retired publication and rebuilds its month without future daily data', async () => {
    const executed: Array<{ sql: string; params?: unknown[] }> = [];
    const manager = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        executed.push({ sql, params });
        if (sql.includes('pg_try_advisory_xact_lock')) {
          return [{ locked: true }];
        }
        if (sql.includes(`SET "status" = 'active'`)) {
          return [[{ id: 'retired-publication' }], 1];
        }
        if (sql.includes('UPDATE "statistic_publication_state"')) {
          return [[{ revision: '9' }], 1];
        }
        if (
          sql.includes('WITH target AS MATERIALIZED') &&
          sql.includes('UPDATE "statistic_commune" statistic')
        ) {
          return [
            {
              targetCount: 1,
              targetDate: '2026-08-01',
              expected: 2,
              affected: 2,
            },
          ];
        }
        if (sql.includes('FROM "zone_publication_state"')) {
          return [
            {
              activePublicationId: 'current-publication',
              candidatePublicationId: 'retired-publication',
              candidateRequestedAt: new Date(),
            },
          ];
        }
        if (
          sql.includes('FROM "zone_publication"') &&
          sql.includes('FOR UPDATE')
        ) {
          return [
            {
              id: 'retired-publication',
              status: 'retired',
              sourceRevision: 'current-source',
              materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
              zoneCount: 10,
              communeLinkCount: 20,
              contentFingerprint: 'a'.repeat(64),
              sourceComputedAt: new Date('2026-08-01T08:00:00Z'),
            },
          ];
        }
        if (sql.includes('FROM "zone_publication_source_state"')) {
          return [{ revision: 'current-source' }];
        }
        if (sql.includes('FROM "zone_publication_instance"')) {
          return [{ liveInstances: 2, readyInstances: 2 }];
        }
        if (sql.includes('FROM "statistic_publication_state"')) {
          return [{ historicDirtyFrom: null, historicDirtyThrough: null }];
        }
        if (
          sql.includes('FROM "statistic_commune_snapshot"') &&
          sql.includes('FOR UPDATE')
        ) {
          return [
            {
              snapshotDate: '2026-08-01',
              scope: 'national',
              status: 'completed',
              sourceRevision: 'current-source',
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

    await expect(
      service.activateWhenReady({ minimumReadyInstances: 2 }),
    ).resolves.toEqual({
      status: 'activated',
      publicationId: 'retired-publication',
      liveInstances: 2,
      readyInstances: 2,
      rollback: true,
    });

    expect(
      executed.some(
        ({ sql, params }) =>
          sql.includes(`SET "status" = 'retired'`) &&
          params?.[0] === 'current-publication',
      ),
    ).toBe(true);
    expect(
      executed.some(
        ({ sql, params }) =>
          sql.includes(`SET "status" = 'active'`) &&
          sql.includes('"legacyPromotedAt" = CASE') &&
          params?.[0] === 'retired-publication' &&
          params?.[1] === true,
      ),
    ).toBe(true);
    expect(
      executed.some(
        ({ sql, params }) =>
          sql.includes('UPDATE "zone_publication_state"') &&
          sql.includes('"automaticPublishingPaused"') &&
          params?.[0] === 'retired-publication' &&
          params?.[1] === true,
      ),
    ).toBe(true);
    expect(
      executed.some(
        ({ sql }) =>
          sql.includes('pg_try_advisory_xact_lock') &&
          sql.includes("hashtext('zone-compute-global')"),
      ),
    ).toBe(true);
    expect(
      executed.some(
        ({ sql, params }) =>
          sql.includes('DELETE FROM "statistic_commune_snapshot"') &&
          sql.includes('"snapshotDate" > $1::date') &&
          params?.[0] === '2026-08-01',
      ),
    ).toBe(true);
    const rollbackMonthlyIndex = executed.findIndex(
      ({ sql }) =>
        sql.includes('WITH target AS MATERIALIZED') &&
        sql.includes('UPDATE "statistic_commune" statistic'),
    );
    const globalComputeLockIndex = executed.findIndex(({ sql }) =>
      sql.includes("hashtext('zone-compute-global')"),
    );
    const historicComputeLockIndex = executed.findIndex(({ sql }) =>
      sql.includes("hashtext('zone-compute-historic')"),
    );
    const statisticPublicationIndex = executed.findIndex(({ sql }) =>
      sql.includes('UPDATE "statistic_publication_state"'),
    );
    expect(dataSource.transaction).toHaveBeenCalledWith(
      'SERIALIZABLE',
      expect.any(Function),
    );
    expect(globalComputeLockIndex).toBeGreaterThan(-1);
    expect(historicComputeLockIndex).toBeGreaterThan(globalComputeLockIndex);
    expect(historicComputeLockIndex).toBeLessThan(rollbackMonthlyIndex);
    expect(rollbackMonthlyIndex).toBeGreaterThan(-1);
    expect(rollbackMonthlyIndex).toBeLessThan(statisticPublicationIndex);
    expect(executed[rollbackMonthlyIndex].params).toEqual([
      'retired-publication',
    ]);
    expect(executed[rollbackMonthlyIndex].sql).toContain(
      `daily.value ->> 'date' >= target."monthStart"::text`,
    );
    expect(executed[rollbackMonthlyIndex].sql).toContain(
      `daily.value ->> 'date' <= target."targetDate"::text`,
    );
    expect(executed[rollbackMonthlyIndex].sql).toContain(
      `'date', target."targetMonth"`,
    );
    expect(
      executed.some(
        ({ sql, params }) =>
          sql.includes('UPDATE "statistic_publication_state"') &&
          sql.includes('"revision" = statistic_state."revision" + 1') &&
          sql.includes('"currentPublishedDate" = (') &&
          sql.includes('"historicPublishedThrough" = LEAST(') &&
          sql.includes("AT TIME ZONE 'UTC'") &&
          params?.[0] === 'retired-publication',
      ),
    ).toBe(true);
  });

  it('aborts rollback before revision and map switch when the monthly rebuild is incomplete', async () => {
    const executed: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string) => {
        executed.push(sql);
        if (sql.includes('pg_try_advisory_xact_lock')) {
          return [{ locked: true }];
        }
        if (
          sql.includes('WITH target AS MATERIALIZED') &&
          sql.includes('UPDATE "statistic_commune" statistic')
        ) {
          return [
            {
              targetCount: 1,
              targetDate: '2026-08-01',
              expected: 2,
              affected: 1,
            },
          ];
        }
        if (sql.includes('FROM "zone_publication_state"')) {
          return [
            {
              activePublicationId: 'publication-2026-08-02',
              candidatePublicationId: 'publication-2026-08-01',
            },
          ];
        }
        if (
          sql.includes('FROM "zone_publication"') &&
          sql.includes('FOR UPDATE')
        ) {
          return [
            {
              id: 'publication-2026-08-01',
              status: 'retired',
              sourceRevision: 'current-source',
              materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
              zoneCount: 10,
              communeLinkCount: 20,
              sourceComputedAt: new Date('2026-08-01T08:00:00Z'),
            },
          ];
        }
        if (sql.includes('FROM "zone_publication_source_state"')) {
          return [{ revision: 'current-source' }];
        }
        if (sql.includes('FROM "zone_publication_instance"')) {
          return [{ liveInstances: 2, readyInstances: 2 }];
        }
        if (sql.includes('FROM "statistic_publication_state"')) {
          return [{ historicDirtyFrom: null, historicDirtyThrough: null }];
        }
        if (
          sql.includes('FROM "statistic_commune_snapshot"') &&
          sql.includes('FOR UPDATE')
        ) {
          return [
            {
              snapshotDate: '2026-08-01',
              scope: 'national',
              status: 'completed',
              sourceRevision: 'current-source',
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

    await expect(
      service.activateWhenReady({ minimumReadyInstances: 2 }),
    ).rejects.toThrow(
      'Rollback monthly statistic rebuild failed for publication publication-2026-08-01: 1/2 rows updated',
    );

    expect(
      executed.some((sql) =>
        sql.includes('UPDATE "statistic_publication_state"'),
      ),
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
              materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
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
      query: jest.fn().mockResolvedValue([[{ id: 'expired-retired' }], 1]),
    };
    const service = new ZonePublicationService(dataSource as any);

    await expect(service.purgeExpiredPublications()).resolves.toEqual([
      'expired-retired',
    ]);
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining(
        `publication."status" IN ('retired', 'superseded', 'failed')`,
      ),
      [4, 48, ZONE_PUBLICATION_MATERIALIZATION_VERSION],
    );
    const sql = dataSource.query.mock.calls[0][0];
    expect(sql).toContain(
      `publication."id" IS DISTINCT FROM state."activePublicationId"`,
    );
    expect(sql).toContain(
      `publication."id" IS DISTINCT FROM state."candidatePublicationId"`,
    );
    expect(sql).not.toContain(`'active', 'candidate'`);
    expect(sql).toContain(
      `daily_run."metadata" ->> 'publicationId' =\n                    publication."id"::text`,
    );
    expect(sql).toContain(`SELECT MAX(latest_daily."scheduledFor")`);
    expect(sql).toContain(`publication."sourceComputedAt"`);
    expect(sql).toContain(`AT TIME ZONE 'Europe/Paris'`);
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

    expect(dataSource.query).toHaveBeenCalledWith(expect.any(String), [
      6,
      72,
      ZONE_PUBLICATION_MATERIALIZATION_VERSION,
    ]);
  });

  it('makes abandoned building and validated publications purgeable', async () => {
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValueOnce([[{ id: 'building' }], 1])
        .mockResolvedValueOnce([[{ id: 'validated' }], 1]),
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
      [600, ZONE_PUBLICATION_MATERIALIZATION_VERSION],
    );
    const validatedExpirySql = dataSource.query.mock.calls[1][0] as string;
    expect(validatedExpirySql).toContain(
      `daily_run."jobKey" = 'compute:national-daily'`,
    );
    expect(validatedExpirySql).toContain(
      `daily_run."metadata" ->> 'publicationId' =`,
    );
    expect(validatedExpirySql).toContain(
      'SELECT MAX(latest_daily."scheduledFor")',
    );
  });

  it('purges stale instance heartbeats independently from publications', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([[{ instanceId: 'old-process' }], 1]),
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

  it('keeps a complete snapshot validated until statistics are certified', async () => {
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
        if (sql.includes('ambiguous_zone_types')) {
          return [{ count: 0 }];
        }
        if (sql.includes('AS "zoneCount"')) {
          return [{ zoneCount: 1, communeLinkCount: 1 }];
        }
        if (sql.includes('INSERT INTO "zone_publication_aggregate"')) {
          return [{ publicationId: 'publication' }];
        }
        if (sql.includes(`SET "status" = 'validated'`)) {
          return [[{ id: 'publication' }], 1];
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
    expect(markCandidate).not.toHaveBeenCalled();
    expect(
      manager.query.mock.calls.some(([sql]) =>
        sql.includes(`SET "status" = 'validated'`),
      ),
    ).toBe(true);
  });

  it('rejects a snapshot whose zone count differs from the immutable artifacts', async () => {
    const twoFeatureArtifact = geojsonArtifact(2);
    const twoFeatureChecksum = createHash('sha256')
      .update(twoFeatureArtifact)
      .digest('hex');
    const manager = { query: jest.fn() };
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
      query: jest.fn().mockResolvedValue([]),
    };
    const service = new ZonePublicationService(dataSource as any);
    fetchSpy.mockImplementation(async (url) => {
      const content = String(url).endsWith('.pmtiles')
        ? PMTILES_ARTIFACT
        : twoFeatureArtifact;
      return new Response(content, { status: 200 });
    });
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
        geojsonChecksum: twoFeatureChecksum,
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
        artifactZoneCount: 1,
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
        artifactZoneCount: 1,
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
        artifactZoneCount: 1,
        geojsonUrl: 'https://example.test/zones-hash.geojson',
        geojsonChecksum: GEOJSON_CHECKSUM,
        pmtilesUrl: 'https://example.test/zones-hash.pmtiles',
        pmtilesChecksum: malformedChecksum,
      }),
    ).rejects.toThrow('PMTiles publication artifact header is invalid');
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects a checksum-valid GeoJSON whose feature count is inconsistent', async () => {
    const twoFeatureArtifact = geojsonArtifact(2);
    const twoFeatureChecksum = createHash('sha256')
      .update(twoFeatureArtifact)
      .digest('hex');
    const dataSource = {
      transaction: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    };
    const service = new ZonePublicationService(dataSource as any);
    fetchSpy.mockImplementation(async (url) => {
      const content = String(url).endsWith('.pmtiles')
        ? PMTILES_ARTIFACT
        : twoFeatureArtifact;
      return new Response(content, { status: 200 });
    });

    await expect(
      service.buildCandidateFromCurrentComputed({
        sourceRevision: '9',
        sourceComputedAt: new Date('2026-07-31T12:00:00Z'),
        artifactZoneCount: 1,
        geojsonUrl: 'https://example.test/zones-hash.geojson',
        geojsonChecksum: twoFeatureChecksum,
        pmtilesUrl: 'https://example.test/zones-hash.pmtiles',
        pmtilesChecksum: PMTILES_CHECKSUM,
      }),
    ).rejects.toThrow(
      'GeoJSON publication artifact contains 2 features; expected 1',
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects a checksum-valid PMTiles without tile data for a non-empty publication', async () => {
    const emptyPmtiles = Buffer.from(PMTILES_ARTIFACT);
    [64, 72, 80, 88].forEach((offset) =>
      emptyPmtiles.writeBigUInt64LE(0n, offset),
    );
    const emptyPmtilesChecksum = createHash('sha256')
      .update(emptyPmtiles)
      .digest('hex');
    const dataSource = {
      transaction: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    };
    const service = new ZonePublicationService(dataSource as any);
    fetchSpy.mockImplementation(async (url) => {
      const content = String(url).endsWith('.pmtiles')
        ? emptyPmtiles
        : GEOJSON_ARTIFACT;
      return new Response(content, { status: 200 });
    });

    await expect(
      service.buildCandidateFromCurrentComputed({
        sourceRevision: '9',
        sourceComputedAt: new Date('2026-07-31T12:00:00Z'),
        artifactZoneCount: 1,
        geojsonUrl: 'https://example.test/zones-hash.geojson',
        geojsonChecksum: GEOJSON_CHECKSUM,
        pmtilesUrl: 'https://example.test/zones-hash.pmtiles',
        pmtilesChecksum: emptyPmtilesChecksum,
      }),
    ).rejects.toThrow('PMTiles publication artifact contains no tile data');
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
        if (sql.includes('ambiguous_zone_types')) {
          return [{ count: 0 }];
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
    fetchSpy.mockImplementation(async (url) => {
      const content = String(url).endsWith('.pmtiles')
        ? PMTILES_ARTIFACT
        : EMPTY_GEOJSON_ARTIFACT;
      return new Response(content, { status: 200 });
    });
    const markCandidate = jest.spyOn(service, 'markCandidate');

    await expect(
      service.buildCandidateFromCurrentComputed({
        sourceRevision: '9',
        sourceComputedAt: new Date('2026-07-31T12:00:00Z'),
        artifactZoneCount: 0,
        geojsonUrl: 'https://example.test/zones-hash.geojson',
        geojsonChecksum: EMPTY_GEOJSON_CHECKSUM,
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
        if (sql.includes('INSERT INTO "zone_publication_aggregate"')) {
          return [{ publicationId: 'publication' }];
        }
        return [];
      }),
    };
    const dataSource = {
      transaction: jest.fn((_isolation, callback) => callback(manager)),
      query: jest.fn().mockResolvedValue([]),
    };
    const service = new ZonePublicationService(dataSource as any);
    fetchSpy.mockImplementation(async (url) => {
      const content = String(url).endsWith('.pmtiles')
        ? PMTILES_ARTIFACT
        : EMPTY_GEOJSON_ARTIFACT;
      return new Response(content, { status: 200 });
    });
    const markCandidate = jest.spyOn(service, 'markCandidate');

    await service.buildCandidateFromCurrentComputed({
      sourceRevision: '9',
      sourceComputedAt: new Date('2026-07-31T12:00:00Z'),
      artifactZoneCount: 0,
      geojsonUrl: 'https://example.test/zones-hash.geojson',
      geojsonChecksum: EMPTY_GEOJSON_CHECKSUM,
      pmtilesUrl: 'https://example.test/zones-hash.pmtiles',
      pmtilesChecksum: PMTILES_CHECKSUM,
    });

    expect(markCandidate).not.toHaveBeenCalled();
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('AS "hasPublishedArrete"'),
    );
  });
});
