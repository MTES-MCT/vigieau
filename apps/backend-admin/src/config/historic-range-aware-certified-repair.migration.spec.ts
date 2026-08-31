import { HistoricRangeAwareCertifiedRepair1788199200000 } from '../migrations/1788199200000-HistoricRangeAwareCertifiedRepair';

describe('HistoricRangeAwareCertifiedRepair1788199200000', () => {
  it('installs append-only range ledgers, a guarded writer and fail-closed resolver', async () => {
    const statements: string[] = [];
    const query = jest.fn(async (sql: string) => {
      statements.push(sql);
      return [];
    });

    await new HistoricRangeAwareCertifiedRepair1788199200000().up({
      query,
    } as any);

    const sql = statements.join('\n');
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS "historic_range_invalidation"',
    );
    expect(sql).toContain('"TRG_historic_range_invalidation_append_only"');
    expect(sql).toContain('"certified_history_repair_attestation"');
    expect(sql).toContain('vigieau.certified_history_attestation_id');
    expect(sql).toContain('"TRG_config_record_historic_range_invalidation"');
    expect(sql).toContain('legacy-epoch-writer-fallback');
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION "record_historic_compute_invalidation"',
    );
    expect(sql).toContain(
      'CREATE OR REPLACE VIEW "active_certified_history_repair"',
    );
    expect(sql).toContain('invalidation."affectedRange" && daterange(');
    expect(sql).toContain('candidate."attestedThroughEpoch" <=');
    expect(sql).toContain('snapshot."certifiedHistoryRepairId" = repair.id');
    expect(sql).not.toContain(
      'repair."historicComputeEpoch" = config."historicComputeEpoch"',
    );
  });

  it('drops the resolver before its ledgers', async () => {
    const statements: string[] = [];
    const query = jest.fn(async (sql: string) => {
      statements.push(sql);
      return [];
    });

    await new HistoricRangeAwareCertifiedRepair1788199200000().down({
      query,
    } as any);

    expect(statements[0]).toContain(
      'DROP VIEW IF EXISTS "active_certified_history_repair"',
    );
    expect(
      statements.findIndex((sql) =>
        sql.includes('DROP TABLE IF EXISTS "historic_range_invalidation"'),
      ),
    ).toBeGreaterThan(
      statements.findIndex((sql) =>
        sql.includes(
          'DROP FUNCTION IF EXISTS "record_historic_compute_invalidation"',
        ),
      ),
    );
  });
});
