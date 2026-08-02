import { DataSource, QueryRunner } from 'typeorm';
import { StatisticCommuneService } from './statistic_commune.service';

const postgresUrl = process.env.STATISTIC_COMMUNE_POSTGRES_URL;
const describeWithPostgres = postgresUrl ? describe : describe.skip;

type SnapshotFinalizer = {
  markSnapshotCompleted(
    queryRunner: QueryRunner,
    snapshotDate: string,
    snapshotScope: string,
    processedCommuneCount: number,
    nationalSnapshotAlreadyCompleted: boolean,
    deferCertificationUntilPublication: boolean,
  ): Promise<void>;
};

describeWithPostgres(
  'StatisticCommuneService PostgreSQL snapshot finalization',
  () => {
    let dataSource: DataSource;
    let queryRunner: QueryRunner;
    let finalizer: SnapshotFinalizer;

    beforeAll(async () => {
      dataSource = await new DataSource({
        type: 'postgres',
        url: postgresUrl,
        entities: [],
        synchronize: false,
        logging: false,
      }).initialize();
      finalizer = new StatisticCommuneService(
        {} as never,
        {} as never,
        dataSource,
      ) as unknown as SnapshotFinalizer;
    });

    beforeEach(async () => {
      queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
    });

    afterEach(async () => {
      if (queryRunner?.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      if (queryRunner) {
        await queryRunner.release();
      }
    });

    afterAll(async () => {
      if (dataSource?.isInitialized) {
        await dataSource.destroy();
      }
    });

    it.each([
      {
        snapshotDate: '9998-12-30',
        deferCertificationUntilPublication: true,
        expectedStatus: 'ready',
        completedAtIsNull: true,
      },
      {
        snapshotDate: '9998-12-31',
        deferCertificationUntilPublication: false,
        expectedStatus: 'completed',
        completedAtIsNull: false,
      },
    ])(
      'persists a $expectedStatus national snapshot without ambiguous parameter types',
      async ({
        snapshotDate,
        deferCertificationUntilPublication,
        expectedStatus,
        completedAtIsNull,
      }) => {
        await queryRunner.query(
          `
          INSERT INTO "statistic_commune_snapshot" (
            "snapshotDate",
            "scope",
            "status",
            "expectedCommuneCount",
            "processedCommuneCount"
          ) VALUES ($1, 'national', 'running', 1, 1)
        `,
          [snapshotDate],
        );

        await finalizer.markSnapshotCompleted(
          queryRunner,
          snapshotDate,
          'national',
          1,
          false,
          deferCertificationUntilPublication,
        );

        const [snapshot] = await queryRunner.query(
          `
          SELECT
            "status",
            "completedAt" IS NULL AS "completedAtIsNull"
          FROM "statistic_commune_snapshot"
          WHERE "snapshotDate" = $1
            AND "scope" = 'national'
        `,
          [snapshotDate],
        );
        expect(snapshot).toEqual({
          status: expectedStatus,
          completedAtIsNull,
        });
      },
    );
  },
);
