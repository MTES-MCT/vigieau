import { ExternalPublicationRegistry1785604800000 } from '../migrations/1785604800000-ExternalPublicationRegistry';

describe('ExternalPublicationRegistry migration', () => {
  it('creates durable resource and unique daily run registries', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new ExternalPublicationRegistry1785604800000();

    await migration.up({ query } as any);

    const sql = query.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS "external_publication_resource"',
    );
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS "external_publication_run"',
    );
    expect(sql).toContain('UNIQUE ("jobKey", "scheduledFor")');
    expect(sql).toContain('"retryAfter" TIMESTAMP WITH TIME ZONE');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "scheduler_heartbeat"');
  });
});
