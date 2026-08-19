import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { StatisticCachePublication1786744800000 } from '../../../backend-admin/src/migrations/1786744800000-StatisticCachePublication';
import {
  StatisticCacheArtifactCandidate,
  StatisticCacheArtifactService,
} from './statistic-cache-artifact.service';

const postgresUrl = process.env.STATISTIC_CACHE_ARTIFACT_POSTGRES_URL;
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres(
  'StatisticCacheArtifactService PostgreSQL lifecycle',
  () => {
    const schemaName = `statistic_cache_artifact_${process.pid}_${Date.now()}`;
    const previousRequired = process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED;
    const previousPublicSourceRevision =
      process.env.PUBLIC_SOURCE_REVISION_ENABLED;
    let bootstrapDataSource: DataSource;
    let dataSource: DataSource;
    let firstService: StatisticCacheArtifactService;
    let secondService: StatisticCacheArtifactService;

    const fingerprint = (value: string) =>
      createHash('sha256').update(value).digest('hex');
    const previousDate = (value: string) => {
      const date = new Date(`${value}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() - 1);
      return date.toISOString().slice(0, 10);
    };

    const candidate = (
      statisticRevision: string,
      currentPublishedDate: string,
      value: number,
    ): StatisticCacheArtifactCandidate => ({
      statisticRevision,
      currentPublishedDate,
      mode: 'legacy-bootstrap',
      materializationStrategy: 'full-clean',
      historicDirtyFrom: null,
      historicDirtyThrough: null,
      historicMapCursor: previousDate(currentPublishedDate),
      historicStatsCursor: previousDate(currentPublishedDate),
      sourceRevision: '42',
      historicComputeEpoch: '7',
      contentFingerprint: fingerprint(
        `${statisticRevision}:${currentPublishedDate}:${value}`,
      ),
      firstDate: currentPublishedDate,
      latestDate: currentPublishedDate,
      dateCount: 1,
      departmentCount: 101,
      communeCount: 1,
      dataArea: [
        { date: currentPublishedDate, ESO: {}, ESU: {}, AEP: { value } },
      ],
      dataDepartement: [{ date: currentPublishedDate, departements: [] }],
      dataCommune: [
        {
          code: '01001',
          restrictions: [{ d: currentPublishedDate.slice(0, 7), p: value }],
        },
      ],
      latestCommuneWeights: [['01001', value]],
    });

    async function setBoundary(
      statisticRevision: string,
      currentPublishedDate: string,
    ): Promise<void> {
      await dataSource.query(
        `
        UPDATE "statistic_publication_state"
        SET "revision" = $1::bigint,
            "currentPublishedDate" = $2::date,
            "historicPublishedThrough" = ($2::date - interval '1 day')::date,
            "historicDirtyFrom" = NULL,
            "historicDirtyThrough" = NULL
        WHERE "id" = 1
      `,
        [statisticRevision, currentPublishedDate],
      );
      await dataSource.query(
        `
        UPDATE "config"
        SET "computeMapDate" = ($1::date - interval '1 day')::date,
            "computeStatsDate" = ($1::date - interval '1 day')::date
        WHERE "id" = 1
      `,
        [currentPublishedDate],
      );
      await dataSource.query(
        `
        INSERT INTO "statistic_commune_snapshot" (
          "snapshotDate", "scope", "status", "expectedCommuneCount",
          "processedCommuneCount", "sourceRevision"
        ) VALUES ($1::date, 'national', 'completed', 1, 1, 42)
        ON CONFLICT ("snapshotDate", "scope") DO UPDATE SET
          "status" = EXCLUDED."status",
          "expectedCommuneCount" = EXCLUDED."expectedCommuneCount",
          "processedCommuneCount" = EXCLUDED."processedCommuneCount",
          "sourceRevision" = EXCLUDED."sourceRevision"
      `,
        [currentPublishedDate],
      );
    }

    beforeAll(async () => {
      process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED = 'true';
      process.env.PUBLIC_SOURCE_REVISION_ENABLED = 'false';
      bootstrapDataSource = await new DataSource({
        type: 'postgres',
        url: postgresUrl,
        synchronize: false,
        logging: false,
      }).initialize();
      await bootstrapDataSource.query(`CREATE SCHEMA "${schemaName}"`);
      dataSource = await new DataSource({
        type: 'postgres',
        url: postgresUrl,
        synchronize: false,
        logging: false,
        extra: {
          options: `-c search_path=${schemaName},public`,
        },
      }).initialize();
      await dataSource.query(`
      CREATE TABLE "zone_publication_instance" (
        "instanceId" varchar(200) PRIMARY KEY,
        "heartbeatAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE "zone_publication_source_state" (
        "id" integer PRIMARY KEY,
        "revision" bigint NOT NULL
      );
      CREATE TABLE "config" (
        "id" integer PRIMARY KEY,
        "computeMapDate" date,
        "computeStatsDate" date,
        "computeMapGeneration" bigint NOT NULL DEFAULT 0,
        "computeStatsGeneration" bigint NOT NULL DEFAULT 0,
        "historicComputeEpoch" bigint NOT NULL DEFAULT 0
      );
      CREATE TABLE "statistic_publication_state" (
        "id" integer PRIMARY KEY,
        "revision" bigint NOT NULL,
        "currentPublishedDate" date,
        "historicPublishedThrough" date,
        "historicDirtyFrom" date,
        "historicDirtyThrough" date
      );
      CREATE TABLE "current_zone_recompute_request" (
        "departementId" integer PRIMARY KEY
      );
      CREATE TABLE "statistic_commune_snapshot" (
        "snapshotDate" date NOT NULL,
        "scope" varchar(100) NOT NULL,
        "status" varchar(20) NOT NULL,
        "expectedCommuneCount" integer NOT NULL,
        "processedCommuneCount" integer NOT NULL,
        "sourceRevision" bigint,
        PRIMARY KEY ("snapshotDate", "scope")
      );
      INSERT INTO "zone_publication_source_state" VALUES (1, 42);
      INSERT INTO "config" VALUES (
        1, date '2026-08-14', date '2026-08-14', 1, 1, 7
      );
      INSERT INTO "statistic_publication_state" VALUES (
        1, 10, date '2026-08-15', date '2026-08-14', NULL, NULL
      );
      INSERT INTO "statistic_commune_snapshot" VALUES (
        date '2026-08-15', 'national', 'completed', 1, 1, 42
      )
    `);
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      try {
        await new StatisticCachePublication1786744800000().up(runner);
      } finally {
        await runner.release();
      }
      await dataSource.query(`
        ALTER TABLE "statistic_cache_publication"
          ADD COLUMN "protocolVersion" integer NOT NULL DEFAULT 1;
        ALTER TABLE "statistic_cache_state"
          ADD COLUMN "candidatePublicationId" uuid;
        ALTER TABLE "zone_publication_instance"
          ADD COLUMN "statisticSourceRevision" bigint,
          ADD COLUMN "statisticProtocolVersion" integer,
          ADD COLUMN "candidateStatisticCachePublicationId" uuid,
          ADD COLUMN "candidateStatisticRevision" bigint,
          ADD COLUMN "candidateStatisticPublishedDate" date,
          ADD COLUMN "candidateStatisticSourceRevision" bigint,
          ADD COLUMN "candidateStatisticFingerprint" varchar(64),
          ADD COLUMN "candidateStatisticProtocolVersion" integer,
          ADD COLUMN "candidateStatisticLastError" text
      `);
      firstService = new StatisticCacheArtifactService(dataSource);
      secondService = new StatisticCacheArtifactService(dataSource);
    }, 60_000);

    afterAll(async () => {
      if (dataSource?.isInitialized) {
        await dataSource.destroy();
      }
      if (bootstrapDataSource?.isInitialized) {
        await bootstrapDataSource.query(
          `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`,
        );
        await bootstrapDataSource.destroy();
      }
      if (previousRequired === undefined) {
        delete process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED;
      } else {
        process.env.STATISTIC_CACHE_ARTIFACT_REQUIRED = previousRequired;
      }
      if (previousPublicSourceRevision === undefined) {
        delete process.env.PUBLIC_SOURCE_REVISION_ENABLED;
      } else {
        process.env.PUBLIC_SOURCE_REVISION_ENABLED =
          previousPublicSourceRevision;
      }
    });

    it('serializes publishers, retains active and previous, rolls back, and rematerializes the same source identity', async () => {
      let releaseCandidate!: () => void;
      const candidateBlocked = new Promise<void>((resolve) => {
        releaseCandidate = resolve;
      });
      let factoryCalls = 0;
      const firstPublication = firstService.materialize(
        { statisticRevision: '10', currentPublishedDate: '2026-08-15' },
        async () => {
          factoryCalls += 1;
          await candidateBlocked;
          return candidate('10', '2026-08-15', 1);
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const concurrentPublication = secondService.materialize(
        { statisticRevision: '10', currentPublishedDate: '2026-08-15' },
        async () => {
          factoryCalls += 1;
          return candidate('10', '2026-08-15', 99);
        },
      );
      releaseCandidate();
      const first = await firstPublication;
      await expect(firstService.loadActive()).resolves.toMatchObject({
        identity: {
          id: first.identity.id,
          statisticRevision: '10',
          currentPublishedDate: '2026-08-15',
        },
      });
      const concurrent = await concurrentPublication;
      expect(factoryCalls).toBe(1);
      expect(concurrent.identity.id).toBe(first.identity.id);
      expect(concurrent.identity.contentFingerprint).toBe(
        first.identity.contentFingerprint,
      );

      await setBoundary('11', '2026-08-16');
      const second = await firstService.materialize(
        { statisticRevision: '11', currentPublishedDate: '2026-08-16' },
        async () => candidate('11', '2026-08-16', 2),
      );
      await setBoundary('12', '2026-08-17');
      const third = await firstService.materialize(
        { statisticRevision: '12', currentPublishedDate: '2026-08-17' },
        async () => candidate('12', '2026-08-17', 3),
      );

      const retainedAfterThird = await dataSource.query(`
      SELECT "id"::text AS "id", "status"
      FROM "statistic_cache_publication"
      ORDER BY "createdAt", "id"
    `);
      expect(retainedAfterThird).toEqual(
        expect.arrayContaining([
          { id: second.identity.id, status: 'retired' },
          { id: third.identity.id, status: 'active' },
        ]),
      );
      expect(retainedAfterThird).toHaveLength(2);
      await expect(
        dataSource.query(
          `SELECT COUNT(*)::integer AS "count" FROM "statistic_cache_artifact"`,
        ),
      ).resolves.toEqual([{ count: 6 }]);

      const rolledBack = await firstService.rollbackToPrevious({
        activePublicationId: third.identity.id,
        previousPublicationId: second.identity.id,
      });
      expect(rolledBack.identity.id).toBe(second.identity.id);

      const replacement = await firstService.materialize(
        { statisticRevision: '12', currentPublishedDate: '2026-08-17' },
        async () => candidate('12', '2026-08-17', 4),
      );
      expect(replacement.identity.id).not.toBe(third.identity.id);
      expect(replacement.identity.contentFingerprint).not.toBe(
        third.identity.contentFingerprint,
      );
      const [state] = await dataSource.query(`
      SELECT
        "activePublicationId"::text AS "activePublicationId",
        "previousPublicationId"::text AS "previousPublicationId"
      FROM "statistic_cache_state"
      WHERE "id" = 1
    `);
      expect(state).toEqual({
        activePublicationId: replacement.identity.id,
        previousPublicationId: second.identity.id,
      });
      await expect(firstService.loadActive()).resolves.toMatchObject({
        identity: {
          id: replacement.identity.id,
          contentFingerprint: replacement.identity.contentFingerprint,
        },
        dataCommune: candidate('12', '2026-08-17', 4).dataCommune,
      });

      await expect(
        dataSource.query(
          `
          UPDATE "statistic_cache_artifact"
          SET "checksum" = $1
          WHERE "publicationId" = $2::uuid AND "kind" = 'area'
        `,
          ['0'.repeat(64), replacement.identity.id],
        ),
      ).rejects.toThrow(/immutable/i);
      await expect(
        dataSource.query(
          `
          UPDATE "statistic_cache_publication"
          SET "sourceRevision" = 43
          WHERE "id" = $1::uuid
        `,
          [replacement.identity.id],
        ),
      ).rejects.toThrow(/identity is immutable/i);
    }, 60_000);

    it('does not block a source mutation and rejects the stale repeatable-read candidate', async () => {
      await setBoundary('13', '2026-08-18');
      await dataSource.query(`
        DELETE FROM "current_zone_recompute_request";
        UPDATE "zone_publication_source_state" SET "revision" = 42
        WHERE "id" = 1
      `);
      const [stateBefore] = await dataSource.query(`
        SELECT "activePublicationId"::text AS "activePublicationId"
        FROM "statistic_cache_state"
        WHERE "id" = 1
      `);
      let signalFactoryStarted!: () => void;
      const factoryStarted = new Promise<void>((resolve) => {
        signalFactoryStarted = resolve;
      });
      let releaseFactory!: () => void;
      const factoryBlocked = new Promise<void>((resolve) => {
        releaseFactory = resolve;
      });

      const materialization = firstService.materialize(
        { statisticRevision: '13', currentPublishedDate: '2026-08-18' },
        async (manager) => {
          await manager.query(`
            SELECT "revision"
            FROM "zone_publication_source_state"
            WHERE "id" = 1
          `);
          signalFactoryStarted();
          await factoryBlocked;
          return candidate('13', '2026-08-18', 13);
        },
      );

      try {
        await factoryStarted;
        const currentWorkerLock = dataSource.createQueryRunner();
        await currentWorkerLock.connect();
        try {
          const [globalLock] = await currentWorkerLock.query(
            "SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('zone-compute-global')) AS locked",
          );
          const [snapshotLock] = await currentWorkerLock.query(
            'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
            ['vigieau:statistic-commune:snapshot-computation'],
          );
          expect(globalLock.locked).toBe(true);
          expect(snapshotLock.locked).toBe(true);
          await currentWorkerLock.query(
            "SELECT pg_advisory_unlock(hashtext('vigieau'), hashtext('zone-compute-global'))",
          );
          await currentWorkerLock.query(
            'SELECT pg_advisory_unlock(hashtext($1))',
            ['vigieau:statistic-commune:snapshot-computation'],
          );
        } finally {
          await currentWorkerLock.release();
        }
        const mutation = dataSource.transaction(async (manager) => {
          await manager.query(`
            UPDATE "zone_publication_source_state"
            SET "revision" = 43
            WHERE "id" = 1
          `);
          await manager.query(`
            INSERT INTO "current_zone_recompute_request" ("departementId")
            VALUES (49)
          `);
        });
        const mutationCompletedWithoutWaitingForMaterialization =
          await Promise.race([
            mutation.then(() => true),
            new Promise<false>((resolve) =>
              setTimeout(() => resolve(false), 2_000),
            ),
          ]);
        expect(mutationCompletedWithoutWaitingForMaterialization).toBe(true);
      } finally {
        releaseFactory();
      }

      await expect(materialization).rejects.toThrow(
        'Statistic materialization boundary changed before activation',
      );
      const [stateAfter] = await dataSource.query(`
        SELECT "activePublicationId"::text AS "activePublicationId"
        FROM "statistic_cache_state"
        WHERE "id" = 1
      `);
      expect(stateAfter.activePublicationId).toBe(
        stateBefore.activePublicationId,
      );
      await expect(
        dataSource.query(`
          SELECT COUNT(*)::integer AS "count"
          FROM "statistic_cache_publication"
          WHERE "statisticRevision" = 13
        `),
      ).resolves.toEqual([{ count: 0 }]);
    }, 60_000);
  },
);
