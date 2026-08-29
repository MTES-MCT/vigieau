import { CertifiedHistoryRepairAudit1787910600000 } from '../migrations/1787910600000-CertifiedHistoryRepairAudit';

describe('CertifiedHistoryRepairAudit1787910600000', () => {
  it('installs an immutable-range audit, snapshot provenance and cache strategy', async () => {
    const statements: string[] = [];
    const query = jest.fn(async (sql: string) => {
      statements.push(sql);
      return [];
    });

    await new CertifiedHistoryRepairAudit1787910600000().up({ query } as any);

    const sql = statements.join('\n');
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS "certified_history_repair_audit"',
    );
    expect(sql).toContain('"activationKind" = \'statistics-only\'');
    expect(sql).toContain('"mapManifestRunId" IS NULL');
    expect(sql).toContain('"publicationRevisionAfter" =');
    expect(sql).toContain('"publicationRevisionBefore" + 1');
    expect(sql).toContain('"TRG_certified_history_repair_audit_append_only"');
    expect(sql).toContain('BEFORE UPDATE OR DELETE');
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "certifiedHistoryRepairId" uuid',
    );
    expect(sql).toContain('BEFORE INSERT OR UPDATE');
    expect(sql).toContain('AFTER INSERT');
    expect(sql).toContain('AFTER UPDATE');
    expect(sql).toContain('AFTER DELETE');
    expect(sql).toContain('REFERENCING OLD TABLE AS old_snapshot_rows');
    expect(sql).toContain('vigieau.certified_history_promotion_id');
    expect(sql).toContain('vigieau.certified_history_revocation_in_progress');
    expect(sql).not.toContain('pg_trigger_depth()');
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('vigieau:statistic-commune:snapshot-computation');
    expect(sql).toContain(
      'UPDATE "statistic_commune_snapshot" repaired_snapshot',
    );
    expect(sql).toContain('"FK_statistic_cache_publication_certified_repair"');
    expect(sql).toContain('"TRG_statistic_cache_publication_repair_immutable"');
    expect(sql).toContain(
      '"materializationStrategy" = \'certified-history-overlay\'',
    );
    expect(sql).toContain("'certified-history-overlay'");
  });

  it('removes dependent snapshot provenance before the ledger', async () => {
    const statements: string[] = [];
    const query = jest.fn(async (sql: string) => {
      statements.push(sql);
      return [];
    });

    await new CertifiedHistoryRepairAudit1787910600000().down({ query } as any);

    expect(statements[0]).toContain(
      'cannot remove certified repair audit while overlay publications exist',
    );
    expect(statements[0]).toContain(
      'OR "certifiedHistoryRepairId" IS NOT NULL',
    );
    expect(statements.join('\n')).not.toContain(
      `SET "materializationStrategy" = 'current-replace'`,
    );

    expect(
      statements.findIndex((sql) =>
        sql.includes('DROP COLUMN IF EXISTS "certifiedHistoryRepairId"'),
      ),
    ).toBeLessThan(
      statements.findIndex((sql) =>
        sql.includes('DROP TABLE IF EXISTS "certified_history_repair_audit"'),
      ),
    );
  });
});
