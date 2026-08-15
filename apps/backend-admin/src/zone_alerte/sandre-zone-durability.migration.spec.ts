import { SandreZoneDurability1786395600000 } from '../migrations/1786395600000-SandreZoneDurability';
import { SandreZoneSchemaPrerequisites1786392000000 } from '../migrations/1786392000000-SandreZoneSchemaPrerequisites';

describe('SandreZoneSchemaPrerequisites1786392000000', () => {
  it('restores every column read by durability without destructive SQL', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => statements.push(sql)),
    };

    const migration = new SandreZoneSchemaPrerequisites1786392000000();
    await migration.up(queryRunner as any);
    await migration.down();

    const sql = statements.join('\n');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "idSandre" integer');
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "codeSandre" character varying(32)',
    );
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "statutSandre" character varying(20)',
    );
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "dateMajSandre" date');
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "numeroVersionSandre" integer',
    );
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "codesAlternatifs" jsonb');
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "sandrePayloadHash" character varying(64)',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "IDX_zone_alerte_code_sandre_unique"',
    );
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE)\b/);
  });
});

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
