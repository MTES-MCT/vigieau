import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ExternalPublicationRegistry1785604800000 } from '../../../backend-admin/src/migrations/1785604800000-ExternalPublicationRegistry';
import { MatomoStatisticsRunService } from './matomo-statistics-run.service';
import { MatomoReportError } from './matomo-statistics.client';
import { VigieauLogger } from '../logger/vigieau.logger';

const postgresUrl = process.env.MATOMO_STATISTICS_POSTGRES_URL;
const describeWithPostgres = postgresUrl ? describe : describe.skip;

describeWithPostgres('Matomo collection coordination on PostgreSQL', () => {
  const schema = `matomo_statistics_${process.pid}_${Date.now()}`;
  let bootstrap: DataSource;
  let dataSource: DataSource;
  const config = {
    get: (key: string) => (key === 'SENTRY_ENV' ? schema : undefined),
  } as ConfigService;
  const jobKey = `matomo:statistics:${schema}`;
  const service = () => new MatomoStatisticsRunService(dataSource, config);

  beforeAll(async () => {
    bootstrap = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
      logging: false,
      synchronize: false,
    }).initialize();
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    dataSource = await new DataSource({
      type: 'postgres',
      url: postgresUrl,
      logging: false,
      synchronize: false,
      migrations: [ExternalPublicationRegistry1785604800000],
      extra: { options: `-c search_path=${schema}` },
    }).initialize();
    await dataSource.runMigrations();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (bootstrap?.isInitialized) {
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrap.destroy();
    }
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "external_publication_run"');
    jest.spyOn(VigieauLogger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('deduplicates concurrent and sequential instances without affecting publication runs', async () => {
    await dataSource.query(`
      INSERT INTO "external_publication_run" ("jobKey", "scheduledFor", "status")
      VALUES ('datagouv:daily', CURRENT_DATE, 'succeeded')
    `);
    let started!: () => void;
    let finish!: () => void;
    const collecting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const collect = jest.fn(async () => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const first = service().run('configuration', collect);
    await collecting;
    try {
      await service().run('configuration', collect);
      expect(collect).toHaveBeenCalledTimes(1);
    } finally {
      finish();
      await first;
    }
    await service().run('configuration', collect);
    expect(collect).toHaveBeenCalledTimes(1);
    const rows = await dataSource.query(
      'SELECT "jobKey", "status", "attempt" FROM "external_publication_run" ORDER BY "jobKey"',
    );
    expect(rows).toEqual([
      { jobKey: 'datagouv:daily', status: 'succeeded', attempt: 0 },
      { jobKey, status: 'succeeded', attempt: 1 },
    ]);
    const [lock] = await dataSource.query(
      'SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = $1 AND objid = hashtext($2)::oid) AS held',
      ['advisory', `vigieau:external-publication:${jobKey}`],
    );
    expect(lock.held).toBe(false);
  });

  it('persists a safe failure and permits a corrected configuration immediately', async () => {
    const collect = jest
      .fn()
      .mockRejectedValue(
        new MatomoReportError(
          'legacy',
          'VisitsSummary.getVisits',
          'authentication',
          401,
        ),
      );
    await service().run('old-configuration', collect);
    await service().run('old-configuration', collect);
    expect(collect).toHaveBeenCalledTimes(1);
    const [failed] = await dataSource.query(
      'SELECT * FROM "external_publication_run" WHERE "jobKey" = $1',
      [jobKey],
    );
    expect(failed.status).toBe('failed');
    expect(failed.metadata).toEqual({ fingerprint: 'old-configuration' });
    expect(failed.error).toBe(
      'Matomo legacy VisitsSummary.getVisits: authentication (HTTP 401)',
    );
    expect(failed.retryAfter.getTime()).toBeGreaterThan(
      Date.now() + 20 * 60 * 60 * 1000,
    );
    collect.mockResolvedValue(undefined);
    await service().run('new-configuration', collect);
    const [success] = await dataSource.query(
      'SELECT "status", "error", "attempt" FROM "external_publication_run" WHERE "jobKey" = $1',
      [jobKey],
    );
    expect(success).toEqual({ status: 'succeeded', error: null, attempt: 1 });
    expect(collect).toHaveBeenCalledTimes(2);
  });
});
