import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DocumentAntivirusScan1794225600000 } from '../migrations/1794225600000-DocumentAntivirusScan';
import { PostgresDocumentScanJournal } from './document-scan.journal';
import { objectIdentity } from './document-scan.inventory';
import { DocumentScanRecord, DocumentScanReport } from './document-scan.types';

const testUrl = process.env.DOCUMENT_SCAN_TEST_DATABASE_URL;
const integration = testUrl ? describe : describe.skip;

integration('document scan PostgreSQL ledger', () => {
  let client: Client;
  const schema = `antivirus_test_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    const url = new URL(testUrl);
    if (
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/vigieau_antivirus_test'
    ) {
      throw new Error(
        'This integration test requires the disposable local antivirus database',
      );
    }
    client = new Client({ connectionString: testUrl, ssl: false });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    const migration = new DocumentAntivirusScan1794225600000();
    await migration.up({ query: (sql: string) => client.query(sql) } as any);
  });
  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    }
  });
  it('retains incomplete positives across runs and enforces complete clean/quarantine evidence', async () => {
    const journal = new PostgresDocumentScanJournal(client, 'a'.repeat(64));
    const report: DocumentScanReport = {
      runId: randomUUID(),
      execute: true,
      status: 'running',
      scopeHash: 'a'.repeat(64),
      startedAt: new Date().toISOString(),
      inventory: {
        candidates: 1,
        databaseReferences: 1,
        externalReferences: 0,
        outOfScopeReferences: 0,
        invalidReferences: 0,
        listedObjects: 1,
        excludedObjects: 0,
        versionCoverage: 'all-accessible-versions',
      },
      processed: 0,
      resumed: 0,
      remaining: 1,
      bytes: 0,
      counts: {},
    };
    await journal.start(report);
    const object = {
      bucket: 'documents',
      key: '/arrete-cadre/example.pdf',
      versionId: 'v1',
      etag: 'e1',
      size: 4,
      latest: true,
      fichierIds: [42],
    };
    const record: DocumentScanRecord = {
      identity: objectIdentity(object),
      object,
      status: 'scanning',
    };
    await journal.save(report.runId, record);
    await expect(
      journal.save(report.runId, { ...record, status: 'clean' }),
    ).rejects.toMatchObject({ code: '23514' });
    record.result = {
      status: 'infected',
      sha256: 'b'.repeat(64),
      bytes: 4,
      signature: 'Eicar-Test-Signature',
    };
    record.status = 'quarantine_pending';
    await journal.save(report.runId, record);
    expect(await journal.pending()).toEqual([
      expect.objectContaining({
        identity: record.identity,
        status: 'quarantine_pending',
        result: record.result,
      }),
    ]);
    await expect(
      journal.save(report.runId, { ...record, status: 'infected' }),
    ).rejects.toMatchObject({ code: '23514' });
    await journal.save(report.runId, {
      ...record,
      status: 'infected',
      quarantineKey: '_antivirus-quarantine/example',
      quarantineVersionId: 'q1',
    });
    expect(await journal.pending()).toHaveLength(0);
    expect(await journal.previous(record.identity)).toMatchObject({
      status: 'infected',
      quarantineVersionId: 'q1',
      object: { key: '/arrete-cadre/example.pdf' },
    });
    report.status = 'completed';
    report.processed = 1;
    report.remaining = 0;
    await journal.checkpoint(report);
    expect(
      (
        await client.query(
          'SELECT status, report FROM document_scan_run WHERE id=$1',
          [report.runId],
        )
      ).rows[0],
    ).toMatchObject({ status: 'completed', report: { processed: 1 } });
  });
});
