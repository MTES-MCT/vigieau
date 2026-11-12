import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { USER_ACTIVITY_AUDIT_SOURCES } from '../migrations/1794477600000-UserActivityAudit';

describe('audit database capture policy against TypeORM metadata', () => {
  // Loading every entity compiles the shared model on a cold CI worker.
  jest.setTimeout(30000);
  it('uses actual column and junction names, including every resource identity', async () => {
    const dataSource = new DataSource({
      type: 'postgres',
      entities: [
        resolve(__dirname, '../../../../global_shared/**/*.entity.ts'),
      ],
    });
    await (dataSource as any).buildMetadatas();
    const migrationOnlySources = new Set([
      'zone_type_availability',
      'current_zone_recompute_request',
      'statistic_publication_state',
    ]);
    const migrationOnlyColumns = new Set([
      'zone_publication_source_state.legacyDualWrite',
    ]);
    for (const source of USER_ACTIVITY_AUDIT_SOURCES) {
      if (migrationOnlySources.has(source.table)) continue;
      const metadata = dataSource.entityMetadatas.find(
        (entry) => entry.tableName === source.table,
      );
      expect({ table: source.table, exists: !!metadata }).toEqual({
        table: source.table,
        exists: true,
      });
      const columns = new Set(
        metadata!.columns.map((column) => column.databaseName),
      );
      for (const field of [
        ...source.keys,
        ...source.fields,
        ...source.masked,
      ]) {
        if (migrationOnlyColumns.has(`${source.table}.${field}`)) continue;
        expect({
          table: source.table,
          field,
          exists: columns.has(field),
        }).toEqual({
          table: source.table,
          field,
          exists: true,
        });
      }
      const captured = new Set<string>([...source.fields, ...source.masked]);
      for (const column of metadata!.primaryColumns) {
        // The user's immutable UUID intentionally replaces the mutable email as
        // resource key; email remains in the allowlisted identity snapshot.
        expect(captured.has(column.databaseName)).toBe(true);
      }
    }
  });
});
