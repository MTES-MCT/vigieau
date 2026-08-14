import { HistoricDepartmentCheckpoint1786219200000 } from '../migrations/1786219200000-HistoricDepartmentCheckpoint';

describe('HistoricDepartmentCheckpoint1786219200000', () => {
  it('creates a durable department checkpoint table and reuse index', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => queries.push(sql)),
    };

    await new HistoricDepartmentCheckpoint1786219200000().up(
      queryRunner as any,
    );

    expect(queries).toHaveLength(4);
    expect(queries[0]).toContain(
      'ADD COLUMN IF NOT EXISTS "historicComputeEpoch" bigint NOT NULL DEFAULT 0',
    );
    expect(queries[1]).toContain(
      'CREATE TABLE IF NOT EXISTS "historic_department_checkpoint"',
    );
    expect(queries[1]).toContain(
      'PRIMARY KEY ("computedFor", "departementId", "historicComputeEpoch")',
    );
    expect(queries[1]).toContain('"sourceRevision" text NOT NULL');
    expect(queries[1]).toContain('"outputSignature" varchar(64) NOT NULL');
    expect(queries[1]).toContain('REFERENCES "departement"("id")');
    expect(queries[2]).toContain(
      'CREATE INDEX IF NOT EXISTS "IDX_historic_department_checkpoint_reuse"',
    );
    expect(queries[3]).toContain(
      'CREATE INDEX IF NOT EXISTS "IDX_historic_department_checkpoint_cleanup"',
    );
    expect(queries[3]).toContain(
      '"completedAt",\n        "historicComputeEpoch",\n        "sourceRevision"',
    );
  });

  it('drops the checkpoint table on rollback', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new HistoricDepartmentCheckpoint1786219200000().down({
      query,
    } as any);

    expect(query).toHaveBeenNthCalledWith(
      1,
      'DROP TABLE IF EXISTS "historic_department_checkpoint"',
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      'ALTER TABLE "config" DROP COLUMN IF EXISTS "historicComputeEpoch"',
    );
  });
});
