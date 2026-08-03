import { ReconcileTerminalPublicationSnapshots1786219300000 } from '../migrations/1786219300000-ReconcileTerminalPublicationSnapshots';

describe('ReconcileTerminalPublicationSnapshots1786219300000', () => {
  it('installs an atomic trigger for every terminal publication path', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new ReconcileTerminalPublicationSnapshots1786219300000().up({
      query,
    } as any);

    expect(query).toHaveBeenCalledTimes(3);
    const functionSql = query.mock.calls[0][0];
    const triggerSql = query.mock.calls[1][0];
    expect(functionSql).toContain(
      "NEW.\"status\" NOT IN ('failed', 'superseded')",
    );
    expect(functionSql).toContain(
      'OLD."status" IS NOT DISTINCT FROM NEW."status"',
    );
    expect(functionSql).toContain(
      'UPDATE "statistic_commune_snapshot" snapshot',
    );
    expect(functionSql).toContain('snapshot."status" = \'ready\'');
    expect(functionSql).toContain(
      'snapshot."sourceRevision" = NEW."sourceRevision"',
    );
    expect(functionSql).toContain('AND NOT EXISTS (');
    expect(functionSql).toContain(
      "usable_publication.\"status\" IN (\n                  'validated', 'candidate', 'active'",
    );
    expect(functionSql).toContain("AT TIME ZONE 'UTC'");
    expect(triggerSql).toContain(
      'AFTER INSERT OR UPDATE OF "status" ON "zone_publication"',
    );
    expect(triggerSql).toContain('FOR EACH ROW');
  });

  it('reconciles existing ready snapshots without invalidating a usable publication', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new ReconcileTerminalPublicationSnapshots1786219300000().up({
      query,
    } as any);

    const [sql, parameters] = query.mock.calls[2];
    expect(sql).toContain('snapshot."scope" = \'national\'');
    expect(sql).toContain('snapshot."status" = \'ready\'');
    expect(sql).toContain(
      "terminal_publication.\"status\" IN ('failed', 'superseded')",
    );
    expect(sql).toContain(
      'terminal_publication."sourceRevision" =\n                  snapshot."sourceRevision"',
    );
    expect(sql).toContain('AND NOT EXISTS (');
    expect(sql).toContain(
      "usable_publication.\"status\" IN (\n              'validated', 'candidate', 'active'",
    );
    expect(sql).toContain("AT TIME ZONE 'UTC'");
    expect(parameters).toEqual([
      'Zone publication ended before statistic activation',
    ]);
  });

  it('removes the trigger before restoring only snapshots tagged by this migration', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new ReconcileTerminalPublicationSnapshots1786219300000().down({
      query,
    } as any);

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0][0]).toContain(
      'DROP TRIGGER IF EXISTS "TRG_zone_publication_invalidate_terminal_snapshot"',
    );
    expect(query.mock.calls[1][0]).toContain(
      'DROP FUNCTION IF EXISTS invalidate_terminal_zone_publication_snapshot()',
    );
    const [sql, parameters] = query.mock.calls[2];
    expect(sql).toContain('SET "status" = \'ready\'');
    expect(sql).toContain('AND "lastError" = $1');
    expect(parameters).toEqual([
      'Zone publication ended before statistic activation',
    ]);
  });
});
