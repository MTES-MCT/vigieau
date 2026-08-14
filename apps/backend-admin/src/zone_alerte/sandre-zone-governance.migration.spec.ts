import { SandreZoneGovernance1785772800000 } from '../migrations/1785772800000-SandreZoneGovernance';

describe('SandreZoneGovernance1785772800000', () => {
  it('separates observed and applied state and persists batches and decisions', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => statements.push(sql)),
    };

    await new SandreZoneGovernance1785772800000().up(queryRunner as any);

    const sql = statements.join('\n');
    expect(sql).toContain('"observedSnapshotHash"');
    expect(sql).toContain('"appliedSnapshotHash"');
    expect(sql).toContain('"blockedSnapshotHash"');
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS "sandre_zone_sync_batch"',
    );
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS "sandre_zone_sync_decision"',
    );
    expect(sql).toContain('"UQ_sandre_zone_sync_decision_key"');
    expect(sql).toContain('"FK_sandre_zone_sync_decision_candidate_zone"');
  });

  it('removes only governance additions on rollback', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => statements.push(sql)),
    };

    await new SandreZoneGovernance1785772800000().down(queryRunner as any);

    const sql = statements.join('\n');
    expect(sql).toContain('DROP TABLE IF EXISTS "sandre_zone_sync_decision"');
    expect(sql).toContain('DROP TABLE IF EXISTS "sandre_zone_sync_batch"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "observedSnapshotHash"');
    expect(sql).not.toContain('DROP TABLE IF EXISTS "sandre_zone_sync_state"');
  });
});
