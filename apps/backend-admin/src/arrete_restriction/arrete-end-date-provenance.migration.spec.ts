import { ArreteCadre } from '@shared/entities/arrete_cadre.entity';
import { ArreteRestriction } from '@shared/entities/arrete_restriction.entity';
import { getMetadataArgsStorage } from 'typeorm';
import { ArreteEndDateProvenance1786305600000 } from '../migrations/1786305600000-ArreteEndDateProvenance';

describe('ArreteEndDateProvenance1786305600000', () => {
  it('adds matching hidden provenance columns to both arrete entities', () => {
    for (const entity of [ArreteRestriction, ArreteCadre]) {
      const columns = getMetadataArgsStorage().columns.filter(
        (column) => column.target === entity,
      );
      const byName = (name: string) =>
        columns.find((column) => column.propertyName === name)?.options;

      expect(byName('dateFinSaisie')).toMatchObject({
        type: 'date',
        nullable: true,
        select: false,
      });
      expect(byName('dateFinCalculee')).toMatchObject({
        default: false,
        select: false,
      });
      expect(byName('dateFinSaisieConnue')).toMatchObject({
        default: true,
        select: false,
      });
    }
  });

  it('adds provenance without reclassifying historical business data', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => statements.push(sql)),
    };

    await new ArreteEndDateProvenance1786305600000().up(queryRunner as any);

    expect(statements).toHaveLength(4);
    for (const table of ['arrete_restriction', 'arrete_cadre']) {
      const alterIndex = statements.findIndex(
        (sql) =>
          sql.includes(`ALTER TABLE "${table}"`) &&
          sql.includes('ADD COLUMN IF NOT EXISTS "dateFinSaisie" date') &&
          sql.includes(
            'ADD COLUMN IF NOT EXISTS "dateFinCalculee" boolean NOT NULL DEFAULT false',
          ) &&
          sql.includes(
            'ADD COLUMN IF NOT EXISTS "dateFinSaisieConnue" boolean NOT NULL DEFAULT true',
          ),
      );
      expect(alterIndex).toBeGreaterThanOrEqual(0);
    }
    expect(
      statements.some(
        (sql) =>
          sql.includes('IDX_arrete_restriction_replaced_order') &&
          sql.includes('"arreteRestrictionAbrogeId"') &&
          sql.includes('WHERE "arreteRestrictionAbrogeId" IS NOT NULL'),
      ),
    ).toBe(true);
    expect(
      statements.some(
        (sql) =>
          sql.includes('IDX_arrete_cadre_replaced_order') &&
          sql.includes('"arreteCadreAbrogeId"') &&
          sql.includes('WHERE "arreteCadreAbrogeId" IS NOT NULL'),
      ),
    ).toBe(true);

    expect(statements.join('\n')).not.toMatch(/\bUPDATE\b/);
  });

  it('drops only the provenance columns and replacement indexes on rollback', async () => {
    const statements: string[] = [];

    await new ArreteEndDateProvenance1786305600000().down({
      query: jest.fn(async (sql: string) => statements.push(sql)),
    } as any);

    expect(statements).toHaveLength(4);
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining('IDX_arrete_cadre_replaced_order'),
        expect.stringContaining('IDX_arrete_restriction_replaced_order'),
      ]),
    );
    for (const table of ['arrete_restriction', 'arrete_cadre']) {
      const sql = statements.find((statement) =>
        statement.includes(`ALTER TABLE "${table}"`),
      );
      expect(sql).toContain('DROP COLUMN IF EXISTS "dateFinSaisieConnue"');
      expect(sql).toContain('DROP COLUMN IF EXISTS "dateFinCalculee"');
      expect(sql).toContain('DROP COLUMN IF EXISTS "dateFinSaisie"');
      expect(sql).not.toContain('DROP COLUMN IF EXISTS "dateFin"');
    }
  });
});
