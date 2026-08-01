import { ZonePublication1785518400000 } from '../migrations/1785518400000-ZonePublication';

describe('ZonePublication1785518400000', () => {
  it('creates immutable publication tables and source revision triggers', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    };

    await new ZonePublication1785518400000().up(queryRunner as any);

    const migrationSql = statements.join('\n');
    expect(migrationSql).toContain(
      'CREATE TABLE IF NOT EXISTS "zone_publication"',
    );
    expect(migrationSql).toContain(
      'CREATE TABLE IF NOT EXISTS "zone_publication_zone"',
    );
    expect(migrationSql).toContain(
      'CREATE TABLE IF NOT EXISTS "zone_publication_commune"',
    );
    expect(migrationSql).toContain(
      'enforce_zone_publication_content_immutable',
    );
    expect(migrationSql).toContain(
      'enforce_zone_publication_metadata_immutable',
    );
    expect(migrationSql).toContain('"candidateAt" TIMESTAMP WITH TIME ZONE');
    expect(migrationSql).toContain('"failedAt" TIMESTAMP WITH TIME ZONE');
    expect(migrationSql).toContain(
      '"legacyPromotedAt" TIMESTAMP WITH TIME ZONE',
    );
    expect(migrationSql).toContain(
      '"dataGouvPromotedAt" TIMESTAMP WITH TIME ZONE',
    );
    expect(migrationSql).toContain(
      '"promotionLastAttemptAt" TIMESTAMP WITH TIME ZONE',
    );
    expect(migrationSql).toContain('"promotionError" text');
    expect(migrationSql).toContain(
      '"materializationVersion" integer NOT NULL DEFAULT 1',
    );
    expect(migrationSql).toContain(
      'ADD CONSTRAINT "FK_zone_publication_zone_publication"',
    );
    expect(migrationSql).toContain(
      'VALIDATE CONSTRAINT "FK_zone_publication_commune_zone"',
    );
    expect(migrationSql).toContain('old_publication_status');
    expect(migrationSql).toContain('new_publication_status');
    expect(migrationSql).toContain(
      'OLD."publicationId" IS DISTINCT FROM NEW."publicationId"',
    );
    expect(migrationSql).toContain(
      'OLD."sourceZoneId" IS DISTINCT FROM NEW."sourceZoneId"',
    );
    expect(migrationSql).toContain(
      'OLD."publicationZoneId" IS DISTINCT FROM NEW."publicationZoneId"',
    );
    expect(migrationSql).toContain(
      '"TRG_zone_alerte_zone_publication_revision"',
    );
    expect(migrationSql).toContain(
      '"TRG_sandre_zone_alias_zone_publication_revision"',
    );
    expect(migrationSql).not.toContain(
      '"TRG_sandre_zone_sync_state_zone_publication_revision"',
    );
  });

  it('completes constraints when publication tables were precreated', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    };

    await new ZonePublication1785518400000().up(queryRunner as any);

    const migrationSql = statements.join('\n');
    const promotionColumnBackfill = statements.find(
      (sql) =>
        sql.includes('ALTER TABLE "zone_publication"') &&
        sql.includes('ADD COLUMN IF NOT EXISTS "legacyPromotedAt"'),
    );
    expect(promotionColumnBackfill).toContain(
      'ADD COLUMN IF NOT EXISTS "dataGouvPromotedAt"',
    );
    expect(promotionColumnBackfill).toContain(
      'ADD COLUMN IF NOT EXISTS "promotionLastAttemptAt"',
    );
    expect(promotionColumnBackfill).toContain(
      'ADD COLUMN IF NOT EXISTS "promotionError"',
    );
    const keyConstraints = [
      'PK_zone_publication',
      'UQ_zone_publication_revision',
      'PK_zone_publication_zone',
      'UQ_zone_publication_zone_source',
      'UQ_zone_publication_zone_identity',
      'PK_zone_publication_commune',
      'PK_zone_publication_state',
      'PK_zone_publication_instance',
      'PK_zone_publication_source_state',
    ];
    for (const constraint of keyConstraints) {
      expect(migrationSql).toContain(`ADD CONSTRAINT "${constraint}"`);
    }
    expect(migrationSql).toContain('existing_constraint.conkey');
    expect(migrationSql).toContain(
      "ARRAY['publicationId', 'sourceZoneId']::text[]",
    );
    expect(migrationSql).toContain("ARRAY['id', 'publicationId']::text[]");

    const checkConstraints = [
      'CHK_zone_publication_status',
      'CHK_zone_publication_zone_type',
      'CHK_zone_publication_state_singleton',
      'CHK_zone_publication_source_state_singleton',
    ];
    for (const constraint of checkConstraints) {
      expect(migrationSql).toContain(`ADD CONSTRAINT "${constraint}"`);
      expect(migrationSql).toContain(`VALIDATE CONSTRAINT "${constraint}"`);
    }

    expect(
      migrationSql.indexOf(
        'ADD CONSTRAINT "UQ_zone_publication_zone_identity"',
      ),
    ).toBeLessThan(
      migrationSql.indexOf('ADD CONSTRAINT "FK_zone_publication_commune_zone"'),
    );
  });

  it('keeps promotion tracking mutable without weakening publication immutability', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    };

    await new ZonePublication1785518400000().up(queryRunner as any);

    const metadataTrigger = statements.find((sql) =>
      sql.includes(
        'CREATE OR REPLACE FUNCTION enforce_zone_publication_metadata_immutable',
      ),
    );
    expect(metadataTrigger).toContain(
      'NEW."sourceRevision" IS DISTINCT FROM OLD."sourceRevision"',
    );
    for (const operationalField of [
      'legacyPromotedAt',
      'dataGouvPromotedAt',
      'promotionLastAttemptAt',
      'promotionError',
    ]) {
      expect(metadataTrigger).not.toContain(`NEW."${operationalField}"`);
      expect(metadataTrigger).not.toContain(`OLD."${operationalField}"`);
    }
  });

  it('drops every source and immutability trigger created by the migration', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    };

    await new ZonePublication1785518400000().down(queryRunner as any);

    const migrationSql = statements.join('\n');
    expect(migrationSql).toContain(
      'DROP TRIGGER IF EXISTS "TRG_sandre_zone_alias_zone_publication_revision"',
    );
    expect(migrationSql).toContain(
      'DROP FUNCTION IF EXISTS enforce_zone_publication_content_immutable',
    );
    expect(migrationSql).toContain(
      'DROP TABLE IF EXISTS "zone_publication_source_state"',
    );
    expect(migrationSql).toContain(
      'DROP TABLE IF EXISTS "zone_publication_commune"',
    );
    expect(migrationSql).toContain('DROP TABLE IF EXISTS "zone_publication"');
  });
});
