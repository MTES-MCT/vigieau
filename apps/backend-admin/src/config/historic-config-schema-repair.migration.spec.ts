import { HistoricConfigSchemaRepair1786831200000 } from '../migrations/1786831200000-HistoricConfigSchemaRepair';

describe('HistoricConfigSchemaRepair1786831200000', () => {
  it('repairs every historic config column behind the next checkpoint epoch', async () => {
    const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
    const queryRunner = {
      query: jest.fn(async (sql: string, parameters?: unknown[]) => {
        queries.push({ sql, parameters });
        if (sql.includes('AS "configHasNullHistoricComputeEpoch"')) {
          return [
            {
              configHasNullHistoricComputeEpoch: true,
              configIsEmpty: false,
            },
          ];
        }
        if (sql.includes('AS "checkpointEpochAvailable"')) {
          return [{ checkpointEpochAvailable: true }];
        }
        if (sql.includes('AS "nextHistoricComputeEpoch"')) {
          return [{ nextHistoricComputeEpoch: '2' }];
        }
        return [];
      }),
    };

    await new HistoricConfigSchemaRepair1786831200000().up(queryRunner as any);

    const sql = queries.map(({ sql: statement }) => statement).join('\n');
    expect(sql).toContain('ALTER TABLE "config"');
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "computeMapGeneration" bigint NOT NULL DEFAULT 0',
    );
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "computeStatsGeneration" bigint NOT NULL DEFAULT 0',
    );
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "computeMapUpdatedAt" TIMESTAMP WITH TIME ZONE',
    );
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "computeStatsUpdatedAt" TIMESTAMP WITH TIME ZONE',
    );
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "historicComputeEpoch" bigint',
    );
    expect(sql).toContain(
      'LOCK TABLE "historic_department_checkpoint" IN SHARE MODE',
    );
    expect(sql).toContain('MAX("historicComputeEpoch")');
    expect(sql).toContain('UPDATE "config"');
    expect(sql).toContain('ALTER COLUMN "historicComputeEpoch" SET DEFAULT 0');
    expect(sql).toContain('ALTER COLUMN "historicComputeEpoch" SET NOT NULL');
    expect(sql).not.toContain('DROP COLUMN');
    expect(
      queries.find(({ sql: statement }) =>
        statement.includes('UPDATE "config"'),
      )?.parameters,
    ).toEqual(['2']);
  });

  it('never rewrites an existing historic compute epoch', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('AS "configHasNullHistoricComputeEpoch"')) {
          return [
            {
              configHasNullHistoricComputeEpoch: false,
              configIsEmpty: false,
            },
          ];
        }
        return [];
      }),
    };

    await new HistoricConfigSchemaRepair1786831200000().up(queryRunner as any);

    const sql = queries.join('\n');
    expect(sql).not.toContain('UPDATE "config"');
    expect(sql).not.toContain('INSERT INTO "config"');
    expect(sql).not.toContain('historic_department_checkpoint');
  });

  it('seeds an empty config singleton behind the checkpoint fence', async () => {
    const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
    const queryRunner = {
      query: jest.fn(async (sql: string, parameters?: unknown[]) => {
        queries.push({ sql, parameters });
        if (sql.includes('AS "configHasNullHistoricComputeEpoch"')) {
          return [
            {
              configHasNullHistoricComputeEpoch: false,
              configIsEmpty: true,
            },
          ];
        }
        if (sql.includes('AS "checkpointEpochAvailable"')) {
          return [{ checkpointEpochAvailable: true }];
        }
        if (sql.includes('AS "nextHistoricComputeEpoch"')) {
          return [{ nextHistoricComputeEpoch: '2' }];
        }
        return [];
      }),
    };

    await new HistoricConfigSchemaRepair1786831200000().up(queryRunner as any);

    const insert = queries.find(({ sql }) =>
      sql.includes('INSERT INTO "config"'),
    );
    expect(insert?.sql).toContain('ON CONFLICT ("id") DO NOTHING');
    expect(insert?.parameters).toEqual(['2']);
  });

  it('keeps columns owned by earlier migrations on rollback', async () => {
    await expect(
      new HistoricConfigSchemaRepair1786831200000().down(),
    ).resolves.toBeUndefined();
  });
});
