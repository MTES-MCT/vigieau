import { CurrentZoneRecomputeQueue1786309200000 } from '../migrations/1786309200000-CurrentZoneRecomputeQueue';

describe('CurrentZoneRecomputeQueue1786309200000', () => {
  it('creates a per-department durable queue with a monotonic generation', async () => {
    const statements: string[] = [];

    await new CurrentZoneRecomputeQueue1786309200000().up({
      query: jest.fn(async (sql: string) => statements.push(sql)),
    } as any);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain(
      'CREATE TABLE IF NOT EXISTS "current_zone_recompute_request"',
    );
    expect(statements[0]).toContain('"departementId" integer PRIMARY KEY');
    expect(statements[0]).toContain('"generation" bigint NOT NULL DEFAULT 1');
    expect(statements[0]).toContain(
      'FOREIGN KEY ("departementId") REFERENCES "departement"("id")',
    );
    expect(statements[0]).toContain('ON DELETE CASCADE');
    expect(statements[1]).toContain(
      'IDX_current_zone_recompute_request_requested',
    );
    expect(statements[1]).toContain('("requestedAt")');
  });

  it('removes the queue on rollback', async () => {
    const query = jest.fn();

    await new CurrentZoneRecomputeQueue1786309200000().down({ query } as any);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      'DROP TABLE IF EXISTS "current_zone_recompute_request"',
    );
  });
});
