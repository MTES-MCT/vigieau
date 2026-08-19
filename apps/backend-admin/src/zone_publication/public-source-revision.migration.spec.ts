import { PublicSourceRevisionAndStatisticCandidate1787140800000 } from '../migrations/1787140800000-PublicSourceRevisionAndStatisticCandidate';

describe('PublicSourceRevisionAndStatisticCandidate1787140800000', () => {
  it('keeps legacy queue inserts compatible while adding targeted public revisions', async () => {
    const statements: string[] = [];

    await new PublicSourceRevisionAndStatisticCandidate1787140800000().up({
      query: jest.fn(async (sql: string) => statements.push(sql)),
    } as any);

    const sql = statements.join('\n');
    expect(statements[0]).toContain("SET LOCAL lock_timeout = '3s'");
    expect(statements[1]).toContain("SET LOCAL statement_timeout = '15min'");
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "publicRevision" bigint');
    expect(sql).toContain('"legacyDualWrite" boolean NOT NULL DEFAULT true');
    expect(sql).toContain(
      'DROP CONSTRAINT IF EXISTS "CHK_statistic_cache_publication_strategy"',
    );
    expect(sql).toContain("'sparse-current'");
    expect(sql).toContain(
      'VALIDATE CONSTRAINT "CHK_statistic_cache_publication_strategy"',
    );
    expect(sql).toContain('SET "publicRevision" = "revision"');
    expect(sql).toContain('"targetPublicRevision" bigint');
    expect(sql).toContain('"scheduledFor" date');
    expect(sql).toContain('"pendingScheduledDates" date[] NOT NULL DEFAULT');
    expect(sql).toContain('"currentPending" boolean NOT NULL DEFAULT true');
    expect(sql).toContain('"nextAttemptAt" timestamptz');
    expect(sql).toContain('"pendingScheduledDates" || ARRAY["scheduledFor"]');
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION preserve_current_zone_recompute_contexts()',
    );
    expect(sql).toContain('NEW."currentPending" := true');
    expect(sql).toContain('IF OLD."currentPending"');
    expect(sql).toContain('cardinality(OLD."pendingScheduledDates") > 0');
    expect(sql).toContain('ALTER COLUMN "targetPublicRevision" SET DEFAULT 0');
    expect(sql).toContain('ALTER COLUMN "reason" SET DEFAULT \'LEGACY\'');
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS "zone_type_availability"',
    );
    expect(sql).toContain(
      "\"status\" IN ('available', 'confirmed_none', 'unavailable')",
    );
    expect(sql).not.toContain('INSERT INTO "zone_type_availability"');
  });

  it('keeps the legacy trigger as the sole public revision writer during expand', async () => {
    const statements: string[] = [];

    await new PublicSourceRevisionAndStatisticCandidate1787140800000().up({
      query: jest.fn(async (sql: string) => statements.push(sql)),
    } as any);

    const bumpFunction = statements.find((sql) =>
      sql.includes(
        'CREATE OR REPLACE FUNCTION bump_zone_publication_source_revision()',
      ),
    );
    expect(bumpFunction).toContain('"revision" = "revision" + 1');
    expect(bumpFunction).toContain(
      '"publicRevision" = "publicRevision" + CASE',
    );
    expect(bumpFunction).toContain('WHEN "legacyDualWrite" THEN 1');
    expect(bumpFunction).toContain('ELSE 0');
  });

  it('keeps legacy heartbeat inserts, upserts and parent SET NULL compatible', async () => {
    const statements: string[] = [];

    await new PublicSourceRevisionAndStatisticCandidate1787140800000().up({
      query: jest.fn(async (sql: string) => statements.push(sql)),
    } as any);

    const sql = statements.join('\n');
    expect(sql).toContain('"protocolVersion" integer NOT NULL DEFAULT 1');
    expect(sql).toContain('"candidatePublicationId" uuid');
    expect(sql).toContain('"candidateStatisticCachePublicationId" uuid');
    expect(sql).toContain('"candidateStatisticSourceRevision" bigint');
    expect(sql).toContain('"candidateStatisticProtocolVersion" integer');
    expect(sql).toContain('"candidateStatisticLastError" IS NULL');
    expect(sql).toContain(
      '"candidateStatisticProtocolVersion" IS NULL\n            AND "candidateStatisticLastError" IS NOT NULL',
    );
    expect(sql).toContain('"candidateStatisticRevision" IS NOT NULL');
    expect(sql).toContain('"candidateStatisticFingerprint" IS NOT NULL');
    expect(sql).toContain('"candidateStatisticProtocolVersion" IS NOT NULL');
    expect(sql).toContain('"statisticRevision" IS NOT NULL');
    expect(sql).toContain('"statisticFingerprint" IS NOT NULL');
    expect(sql).toContain('"statisticProtocolVersion" IS NOT NULL');
    expect(sql).toContain(
      'ALTER COLUMN "statisticProtocolVersion" SET DEFAULT 1',
    );
    expect(sql).toContain(
      'REFERENCES "statistic_cache_publication"("id") ON DELETE RESTRICT',
    );
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION normalize_zone_publication_instance_statistic_identity()',
    );
    expect(sql).toContain('IF NEW."statisticCachePublicationId" IS NULL THEN');
    expect(sql).toContain('NEW."statisticSourceRevision" := NULL');
    expect(sql).toContain('NEW."statisticProtocolVersion" := NULL');
    expect(sql).toContain('ELSIF NEW."statisticProtocolVersion" IS NULL THEN');
    expect(sql).toContain('NEW."statisticProtocolVersion" := 1');
    expect(
      sql.indexOf('ALTER COLUMN "statisticProtocolVersion" SET DEFAULT 1'),
    ).toBeLessThan(
      sql.indexOf(
        'ADD CONSTRAINT "CHK_zone_publication_instance_statistic_identity"',
      ),
    );
    expect(sql).not.toContain(
      'DROP CONSTRAINT IF EXISTS "FK_zone_publication_instance_statistic_cache"',
    );
  });

  it('restores the previous active statistic identity constraint on rollback', async () => {
    const statements: string[] = [];

    await new PublicSourceRevisionAndStatisticCandidate1787140800000().down({
      query: jest.fn(async (sql: string) => statements.push(sql)),
    } as any);

    const sql = statements.join('\n');
    const dropNewColumns = sql.indexOf(
      'DROP COLUMN IF EXISTS "statisticSourceRevision"',
    );
    const restoreOldConstraint = sql.lastIndexOf(
      'ADD CONSTRAINT "CHK_zone_publication_instance_statistic_identity"',
    );
    expect(dropNewColumns).toBeGreaterThanOrEqual(0);
    expect(restoreOldConstraint).toBeGreaterThan(dropNewColumns);
    expect(sql.slice(restoreOldConstraint)).not.toContain(
      '"statisticSourceRevision"',
    );
    expect(sql).toContain(
      'DROP TRIGGER IF EXISTS "TRG_zone_publication_instance_statistic_identity"',
    );
    expect(sql).toContain(
      'DROP TRIGGER IF EXISTS "TRG_preserve_current_zone_recompute_contexts"',
    );
    expect(sql).toContain(
      'DROP FUNCTION IF EXISTS preserve_current_zone_recompute_contexts',
    );
    expect(sql).toContain('DROP COLUMN IF EXISTS "pendingScheduledDates"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "currentPending"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "legacyDualWrite"');
    const restoredStrategyConstraint = sql.indexOf(
      'ADD CONSTRAINT "CHK_statistic_cache_publication_strategy"',
    );
    expect(restoredStrategyConstraint).toBeGreaterThanOrEqual(0);
    expect(sql.slice(restoredStrategyConstraint)).toContain(
      "'current-replace'",
    );
    expect(sql.slice(restoredStrategyConstraint)).not.toContain(
      "'sparse-current'",
    );
    expect(sql).toContain(
      'SET "revision" = "revision" + 1, "updatedAt" = now()',
    );
    expect(sql).toContain(
      'DROP FUNCTION IF EXISTS normalize_zone_publication_instance_statistic_identity',
    );
    expect(sql).not.toContain(
      'DROP CONSTRAINT IF EXISTS "FK_zone_publication_instance_statistic_cache"',
    );
  });
});
