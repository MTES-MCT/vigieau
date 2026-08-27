import { HistoricBackfillControlPlane1787144400000 } from './1787144400000-HistoricBackfillControlPlane';

describe('HistoricBackfillControlPlane1787144400000', () => {
  const runMigration = async () => {
    const statements: string[] = [];

    await new HistoricBackfillControlPlane1787144400000().up({
      query: jest.fn(async (sql: string) => statements.push(sql)),
    } as any);

    return { statements, sql: statements.join('\n') };
  };

  it('creates immutable run context and seeds department revisions', async () => {
    const { statements, sql } = await runMigration();

    expect(statements[0]).toContain("SET LOCAL lock_timeout = '3s'");
    expect(statements[1]).toContain("SET LOCAL statement_timeout = '15min'");
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "historicBackfillGlobalEpoch"',
    );
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS "historic_backfill_department_revision"',
    );
    expect(sql).toContain('"generation" bigint NOT NULL DEFAULT 0');
    expect(sql).toContain('"lastPublicRevision" bigint NOT NULL DEFAULT 0');
    expect(sql).toContain('SELECT departement."id", 0, 0');
    expect(sql).toContain('ON CONFLICT ("departementId") DO NOTHING');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "historic_backfill_run"');
    for (const column of [
      'mapDateFrom',
      'statisticDateFrom',
      'dateThrough',
      'sourceRevision',
      'historicComputeEpoch',
      'historicBackfillGlobalEpoch',
      'baseStatisticRevision',
      'statisticsPromotedAt',
    ]) {
      expect(sql).toContain(`"${column}"`);
    }
    expect(sql).toContain('"statisticsPromotedAt" timestamp with time zone,');
    expect(sql).toContain(
      "'preparing', 'running', 'paused', 'completed', 'failed'",
    );
    expect(sql).toContain('"mapDateFrom" <= "dateThrough"');
    expect(sql).toContain('"statisticDateFrom" <= "dateThrough"');
  });

  it('creates retryable department tasks with anti-ABA leases', async () => {
    const { sql } = await runMigration();

    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS "historic_backfill_task"',
    );
    expect(sql).toContain('PRIMARY KEY ("runId", "departementId")');
    expect(sql).toContain('"departmentGeneration" bigint NOT NULL');
    expect(sql).toContain('"progressDate" date');
    expect(sql).toContain('"segmentCount" integer NOT NULL DEFAULT 0');
    expect(sql).toContain('"communeCount" integer NOT NULL DEFAULT 0');
    expect(sql).toContain('"outputSignature" varchar(64)');
    expect(sql).toContain('"artifactPrefix" text');
    expect(sql).toContain('"leaseToken" uuid');
    expect(sql).toContain('"leaseExpiresAt" timestamp with time zone');
    expect(sql).toContain('"heartbeatAt" timestamp with time zone');
    expect(sql).toContain(
      '"nextAttemptAt" timestamp with time zone NOT NULL DEFAULT now()',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("runId") REFERENCES "historic_backfill_run"("id")',
    );
    expect(sql).toContain('ON DELETE CASCADE');
    expect(sql).toContain('"status" = \'leased\'');
    expect(sql).toContain('"leaseToken" IS NOT NULL');
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "IDX_historic_backfill_task_claim"',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "UQ_historic_backfill_run_active"',
    );
    expect(sql).toContain('WHERE "status" = \'pending\'');
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "IDX_historic_backfill_task_expired_lease"',
    );
  });

  it('stores validated commune intervals for deterministic reduction', async () => {
    const { sql } = await runMigration();

    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS "historic_backfill_commune_segment"',
    );
    expect(sql).toContain('PRIMARY KEY ("runId", "communeId", "validFrom")');
    expect(sql).toContain(
      'FOREIGN KEY ("runId", "departementId")\n' +
        '          REFERENCES "historic_backfill_task"("runId", "departementId")',
    );
    expect(sql).toContain('"validFrom" <= "validThrough"');
    expect(sql).toContain('"sourceGeneration" bigint NOT NULL');
    expect(sql).toContain('"inputSignature" varchar(64) NOT NULL');
    for (const level of ['SOU', 'SUP', 'AEP']) {
      expect(sql).toContain(`"${level}" IS NULL`);
    }
    expect(sql).toContain("'vigilance', 'alerte', 'alerte_renforcee', 'crise'");
    expect(sql).toContain(
      '"IDX_historic_backfill_commune_segment_run_department_dates"',
    );
    expect(sql).toContain(
      '"runId", "departementId", "validFrom", "validThrough"',
    );
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS "historic_backfill_department_segment"',
    );
    expect(sql).toContain(
      'PRIMARY KEY ("runId", "departementId", "validFrom")',
    );
    expect(sql).toContain('jsonb_typeof("restriction") = \'object\'');
    expect(sql).toContain('"geojsonObjectKey" text NOT NULL');
    expect(sql).toContain('"geojsonChecksum" varchar(64) NOT NULL');
    expect(sql).toContain('"featureCount" integer NOT NULL');
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS "historic_backfill_commune_shadow"',
    );
    expect(sql).toContain('PRIMARY KEY ("runId", "communeId")');
    expect(sql).toContain('jsonb_typeof("restrictions") = \'array\'');
    expect(sql).toContain(
      '"IDX_historic_backfill_commune_shadow_run_department"',
    );
  });

  it('creates retryable national artifact tasks', async () => {
    const { sql } = await runMigration();

    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS "historic_backfill_artifact_task"',
    );
    expect(sql).toContain('PRIMARY KEY ("runId", "validFrom")');
    expect(sql).toContain('"pmtilesObjectKey" text');
    expect(sql).toContain('"leaseToken" uuid');
    expect(sql).toContain('"status" = \'leased\'');
    expect(sql).toContain('"IDX_historic_backfill_artifact_task_claim"');
  });

  it('creates a durable singleton pending manifest outbox', async () => {
    const { sql } = await runMigration();

    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS "historic_backfill_map_manifest_outbox"',
    );
    expect(sql).toContain('PRIMARY KEY ("runId")');
    expect(sql).toContain('"manifestBody" text NOT NULL');
    expect(sql).toContain('"manifestChecksum" varchar(64) NOT NULL');
    expect(sql).toContain('"status" = \'pending\' AND "publishedAt" IS NULL');
    expect(sql).toContain('"UQ_historic_backfill_map_manifest_outbox_pending"');
    expect(sql).toContain('WHERE "status" = \'pending\'');
  });

  it('drops all tables in dependency order', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new HistoricBackfillControlPlane1787144400000().down({
      query,
    } as any);

    expect(query.mock.calls.map(([statement]) => statement)).toEqual([
      'DROP TABLE IF EXISTS "historic_backfill_map_manifest_outbox"',
      'DROP TABLE IF EXISTS "historic_backfill_artifact_task"',
      'DROP TABLE IF EXISTS "historic_backfill_commune_shadow"',
      'DROP TABLE IF EXISTS "historic_backfill_department_segment"',
      'DROP TABLE IF EXISTS "historic_backfill_commune_segment"',
      'DROP TABLE IF EXISTS "historic_backfill_task"',
      'DROP TABLE IF EXISTS "historic_backfill_run"',
      'DROP TABLE IF EXISTS "historic_backfill_department_revision"',
      'ALTER TABLE "config" DROP COLUMN IF EXISTS "historicBackfillGlobalEpoch"',
    ]);
  });
});
