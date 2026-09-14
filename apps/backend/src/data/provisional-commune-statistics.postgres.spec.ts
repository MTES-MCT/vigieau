import { DataSource } from 'typeorm';
import { DataService } from './data.service';

const postgresUrl = process.env.STATISTIC_CACHE_ARTIFACT_POSTGRES_URL;
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres('Provisional commune history on PostgreSQL', () => {
  const schemaName = `provisional_commune_${process.pid}_${Date.now()}`;
  let bootstrap: DataSource;
  let source: DataSource;
  let service: DataService;
  const repairId = '11111111-1111-4111-8111-111111111111';
  const day = (date: string) => ({ date, SOU: null, SUP: 'crise', AEP: null });

  beforeAll(async () => {
    bootstrap = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
      synchronize: false,
    }).initialize();
    await bootstrap.query(`CREATE SCHEMA "${schemaName}"`);
    source = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
      synchronize: false,
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize();
    await source.query(`
      CREATE TABLE commune (id integer PRIMARY KEY);
      INSERT INTO commune VALUES (1), (2);
      CREATE TABLE statistic_commune (id integer PRIMARY KEY, restrictions jsonb);
      CREATE TABLE config (id integer, "historicComputeEpoch" bigint);
      INSERT INTO config VALUES (1, 843);
      CREATE TABLE zone_publication_state (id integer, "activePublicationId" uuid);
      INSERT INTO zone_publication_state VALUES (1, '${repairId}');
      CREATE TABLE statistic_publication_state (
        id integer, "currentPublishedDate" date, "historicDirtyFrom" date,
        "historicDirtyThrough" date, revision bigint
      );
      CREATE TABLE active_certified_history_repair (
        id uuid, "activationKind" text, "dateFrom" date, "dateThrough" date,
        "publicationRevisionAfter" bigint, "communeCount" integer, "promotedAt" timestamptz
      );
      CREATE TABLE statistic_commune_snapshot (
        "snapshotDate" date, scope text, status text,
        "expectedCommuneCount" integer, "processedCommuneCount" integer,
        "sourceRevision" bigint, "certifiedHistoryRepairId" uuid
      );
    `);
    service = Object.create(DataService.prototype);
    Object.assign(service, {
      dataSource: source,
      statisticCommuneRepository: {
        findOne: async () => ({
          id: 1,
          commune: { code: '24547', nom: 'Terrasson-Lavilledieu' },
        }),
      },
      getConfiguredStatisticCacheMode: () => 'versioned',
    });
  });

  afterAll(async () => {
    if (source?.isInitialized) await source.destroy();
    if (bootstrap?.isInitialized) {
      await bootstrap.query(`DROP SCHEMA "${schemaName}" CASCADE`);
      await bootstrap.destroy();
    }
  });

  beforeEach(async () => {
    await source.query(`
      TRUNCATE statistic_commune, statistic_commune_snapshot,
        statistic_publication_state, active_certified_history_repair;
      INSERT INTO statistic_publication_state VALUES
        (1, '2026-09-10', '2026-07-11', '2026-08-31', 200);
      INSERT INTO statistic_commune
      SELECT 1, jsonb_agg(jsonb_build_object(
        'date', date::date::text, 'SOU', NULL, 'SUP', 'crise', 'AEP', NULL
      ) ORDER BY date)
      FROM generate_series('2026-07-10'::date, '2026-09-11'::date, '1 day') date;
      INSERT INTO statistic_commune_snapshot
      SELECT date::date, 'national', 'completed', 2, 2, NULL, '${repairId}'::uuid
      FROM generate_series('2026-07-10'::date, '2026-09-11'::date, '1 day') date;
    `);
  });

  it('returns the 52 hidden days only as provisional and preserves strict readers and certification', async () => {
    const strict = await service.commune('24547');
    expect(strict.restrictions).toHaveLength(11);
    const result = await service.commune('24547', undefined, undefined, true);
    expect(result.restrictions).toHaveLength(63);
    expect(
      result.restrictions.filter((entry) => entry.dataStatus === 'provisional'),
    ).toHaveLength(52);
    expect(
      result.restrictions.find((entry) => entry.date === '2026-07-11'),
    ).toEqual({
      ...day('2026-07-11'),
      dataStatus: 'provisional',
      dataStatusReason: 'historic-recalculation',
    });
    expect(result.restrictions[0]).toEqual(day('2026-07-10'));
    expect(result.restrictions.at(-1)).toEqual(day('2026-09-10'));
    expect(
      await source.query('SELECT * FROM active_certified_history_repair'),
    ).toEqual([]);
    expect(
      (
        await source.query(
          'SELECT "historicDirtyFrom"::text FROM statistic_publication_state',
        )
      )[0],
    ).toEqual({ historicDirtyFrom: '2026-07-11' });
  });

  it('respects requested months and returns certified restored days without provisional tags', async () => {
    const provisional = await service.commune(
      '24547',
      '2026-08',
      '2026-08',
      true,
    );
    expect(provisional.restrictions).toHaveLength(31);
    expect(
      provisional.restrictions.every(
        (entry) => entry.dataStatus === 'provisional',
      ),
    ).toBe(true);
    await source.query(`INSERT INTO active_certified_history_repair VALUES
      ('${repairId}', 'statistics-only', '2026-07-11', '2026-08-31', 199, 2, now())`);
    const restored = await service.commune('24547', '2026-08', '2026-08', true);
    expect(restored.restrictions).toHaveLength(31);
    expect(
      restored.restrictions.every((entry) => entry.dataStatus === undefined),
    ).toBe(true);
  });

  it.each(['running', 'partial', 'failed'])(
    'does not serve a %s national snapshot even provisionally',
    async (status) => {
      await source.query(
        `UPDATE statistic_commune_snapshot SET status = $1 WHERE "snapshotDate" = '2026-08-01'`,
        [status],
      );
      const result = await service.commune('24547', '2026-08', '2026-08', true);
      expect(result.restrictions).toHaveLength(30);
      expect(
        result.restrictions.some((entry) => entry.date === '2026-08-01'),
      ).toBe(false);
    },
  );

  it('excludes absent, inconsistent and concurrently recomputed snapshots', async () => {
    await source.query(`
      DELETE FROM statistic_commune_snapshot WHERE "snapshotDate" = '2026-08-01';
      UPDATE statistic_commune_snapshot SET "processedCommuneCount" = 1 WHERE "snapshotDate" = '2026-08-02';
      UPDATE statistic_commune_snapshot SET "expectedCommuneCount" = 1, "processedCommuneCount" = 1 WHERE "snapshotDate" = '2026-08-03';
      INSERT INTO statistic_commune_snapshot VALUES ('2026-08-04', 'department:24', 'running', 1, 0, NULL, NULL);
    `);
    const result = await service.commune('24547', '2026-08', '2026-08', true);
    expect(result.restrictions).toHaveLength(27);
    expect(result.restrictions[0].date).toBe('2026-08-05');
  });

  it('excludes duplicate dates and malformed severities instead of inventing no restrictions', async () => {
    await source.query(
      'UPDATE statistic_commune SET restrictions = $1::jsonb',
      [
        JSON.stringify([
          day('2026-08-01'),
          day('2026-08-01'),
          { ...day('2026-08-02'), SUP: 'unknown' },
          { date: '2026-08-03', SOU: null, AEP: null },
          { ...day('2026-08-04'), SUP: { value: 'crise' } },
          { ...day('2026-08-05'), SUP: null },
        ]),
      ],
    );
    const result = await service.commune('24547', '2026-08', '2026-08', true);
    expect(result.restrictions).toEqual([
      {
        ...day('2026-08-05'),
        SUP: null,
        dataStatus: 'provisional',
        dataStatusReason: 'historic-recalculation',
      },
    ]);
  });
});
