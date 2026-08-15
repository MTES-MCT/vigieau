import { SandreZoneDurability1786395600000 } from '../migrations/1786395600000-SandreZoneDurability';

describe('SandreZoneDurability1786395600000', () => {
  it('adds controlled provenance and the audited Corsica basin mapping only', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => statements.push(sql)),
    };

    await new SandreZoneDurability1786395600000().up(queryRunner as any);

    const sql = statements.join('\n');
    expect(sql).toContain('"sandreProvenance"');
    expect(sql).toContain("'local_preserved'");
    expect(sql).toContain('"numeroVersionSandre" IS NULL');
    expect(sql).toContain('"codesAlternatifs" = \'[]\'::jsonb');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "sandre_basin_mapping"');
    expect(sql).toContain(
      "VALUES (12, 'CORSE', 6, 'audited_official_to_local')",
    );
    expect(sql).not.toContain('4605');
    expect(sql).not.toContain('9704');
    expect(sql).not.toContain('9707');
  });
});
