import 'dotenv/config';
import { S3Client } from '@aws-sdk/client-s3';
import { Client } from 'pg';
import { sha256Text } from '../documents-scan/document-scan.inventory';
import { PostgresDocumentScanJournal } from '../documents-scan/document-scan.journal';
import { runDocumentScan } from '../documents-scan/document-scan.runner';
import {
  FileReference,
  S3DocumentStorage,
  storageErrorCode,
} from '../documents-scan/document-scan.storage';
import { DocumentScanReport } from '../documents-scan/document-scan.types';

export interface DocumentScanArguments {
  execute: boolean;
  limit?: number;
  rescan: boolean;
  help: boolean;
}

export function parseDocumentScanArguments(
  args: string[],
): DocumentScanArguments {
  const result: DocumentScanArguments = {
    execute: false,
    rescan: false,
    help: false,
  };
  let dryRun = false;
  for (let index = 0; index < args.length; index++) {
    switch (args[index]) {
      case '--dry-run':
        dryRun = true;
        break;
      case '--execute':
        result.execute = true;
        break;
      case '--rescan':
        result.rescan = true;
        break;
      case '--help':
        result.help = true;
        break;
      case '--limit': {
        const value = args[++index];
        if (
          !value ||
          !/^[1-9]\d*$/.test(value) ||
          !Number.isSafeInteger(Number(value))
        ) {
          throw new Error('--limit requires a positive integer');
        }
        result.limit = Number(value);
        break;
      }
      default:
        throw new Error('Unknown documents:scan argument');
    }
  }
  if (dryRun && result.execute)
    throw new Error('--dry-run and --execute are mutually exclusive');
  return result;
}

export function documentScanExitCode(report: DocumentScanReport): number {
  if (report.status === 'failed' || report.status === 'interrupted') return 1;
  if (
    Object.entries(report.counts).some(
      ([status, count]) => status !== 'clean' && count > 0,
    )
  )
    return 2;
  if (
    report.execute &&
    (report.inventory.externalReferences > 0 ||
      report.inventory.invalidReferences > 0 ||
      report.inventory.outOfScopeReferences > 0 ||
      report.inventory.versionCoverage !== 'all-accessible-versions')
  )
    return 2;
  return 0;
}

function required(name: string): string {
  if (!process.env[name])
    throw new Error(`Missing required environment variable: ${name}`);
  return process.env[name];
}

export async function scanDocumentsMain(
  args = process.argv.slice(2),
): Promise<number> {
  const options = parseDocumentScanArguments(args);
  if (options.help) {
    console.log(
      'documents:scan [--dry-run | --execute] [--limit N] [--rescan]\n' +
        'Default: read-only DB/S3 inventory. Execute scans sequentially and quarantines positives.\n' +
        '--limit bounds newly attempted objects; --rescan repeats completed versions.\n' +
        'JSONL output; exit 0=success/inventory/limited, 1=failure/interruption, 2=findings or incomplete documents.',
    );
    return 0;
  }
  const config = {
    bucket: required('S3_BUCKET'),
    prefix: process.env.S3_PREFIX ?? '',
    publicBaseUrl: required('S3_VHOST'),
  };
  if (config.prefix && !config.prefix.endsWith('/'))
    throw new Error('S3_PREFIX must be empty or end with /');
  const database = required('DATABASE_NAME');
  const client = new Client({
    host: required('DATABASE_HOST'),
    port: Number(required('DATABASE_PORT')),
    user: required('DATABASE_USER'),
    password: required('DATABASE_PASSWORD'),
    database,
    ssl:
      process.env.NODE_ENV === 'local' ? false : { rejectUnauthorized: false },
    application_name: 'vigieau-document-antivirus-scan',
    statement_timeout: 30_000,
    connectionTimeoutMillis: 30_000,
  });
  const s3 = new S3Client({
    endpoint: required('S3_ENDPOINT'),
    region: required('S3_REGION'),
    forcePathStyle:
      process.env.S3_FORCE_PATH_STYLE === 'true' ||
      process.env.NODE_ENV === 'local',
    credentials: {
      accessKeyId: required('S3_ACCESS_KEY'),
      secretAccessKey: required('S3_SECRET_KEY'),
    },
    maxAttempts: 3,
  });
  const storage = new S3DocumentStorage(s3, config);
  const controller = new AbortController();
  // An idle PG disconnect must not crash Node while a confirmed positive is
  // being confined. Stop subsequent scans; quarantine uses its own bounded signal.
  client.on('error', () => controller.abort());
  const onSignal = () => controller.abort();
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  let connected = false;
  let locked = false;
  const scopeHash = sha256Text(
    JSON.stringify([
      database,
      config.bucket,
      config.prefix,
      config.publicBaseUrl,
    ]),
  );
  try {
    await client.connect();
    connected = true;
    if (options.execute) {
      const schema = await client.query(
        "SELECT to_regclass('document_scan_run') AS run, to_regclass('document_scan_result') AS result",
      );
      if (!schema.rows[0].run || !schema.rows[0].result)
        throw new Error(
          'Document antivirus migration must run before --execute',
        );
      const lock = await client.query(
        'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked',
        ['vigieau-document-scan', scopeHash],
      );
      locked = lock.rows[0].locked;
      if (!locked)
        throw new Error('A document scan is already active for this scope');
    } else {
      await client.query('SET default_transaction_read_only = on');
    }
    const references: FileReference[] = [];
    let afterId = 0;
    while (true) {
      controller.signal.throwIfAborted();
      const page = await client.query(
        'SELECT id, url, size FROM fichier WHERE id > $1 ORDER BY id LIMIT 1000',
        [afterId],
      );
      if (!page.rows.length) break;
      references.push(...page.rows);
      afterId = page.rows[page.rows.length - 1].id;
    }
    console.log(
      JSON.stringify({
        event: 'inventory_start',
        databaseReferences: references.length,
      }),
    );
    const inventoryStarted = Date.now();
    const inventory = await storage.inventory(
      references,
      controller.signal,
      (event) => console.log(JSON.stringify(event)),
    );
    const { objects, ...inventorySummary } = inventory;
    console.log(
      JSON.stringify({
        event: 'inventory_complete',
        ...inventorySummary,
        candidates: objects.length,
        elapsedMs: Date.now() - inventoryStarted,
      }),
    );
    const timeout = Number(process.env.ANTIVIRUS_TIMEOUT_MS ?? 60_000);
    const ageHours = Number(process.env.ANTIVIRUS_MAX_DATABASE_AGE_HOURS ?? 72);
    if (
      !Number.isSafeInteger(timeout) ||
      timeout < 1000 ||
      timeout > 75_000 ||
      !Number.isFinite(ageHours) ||
      ageHours <= 0 ||
      ageHours > 72
    )
      throw new Error('Invalid antivirus historical scan limits');
    const report = await runDocumentScan(
      inventory,
      storage,
      new PostgresDocumentScanJournal(client, scopeHash),
      {
        execute: options.execute,
        limit: options.limit,
        rescan: options.rescan,
        scopeHash,
        signal: controller.signal,
        scannerOptions: {
          executable: process.env.CLAMDSCAN_PATH,
          configFile: process.env.CLAMD_CONFIG_FILE,
          timeoutMs: timeout,
          maxDatabaseAgeMs: ageHours * 60 * 60 * 1000,
        },
        log: (event) => console.log(JSON.stringify(event)),
      },
    );
    console.log(JSON.stringify({ event: 'summary', ...report }));
    return documentScanExitCode(report);
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    if (locked)
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [
          'vigieau-document-scan',
          scopeHash,
        ])
        .catch(() => undefined);
    if (connected) await client.end();
    s3.destroy();
  }
}

if (require.main === module) {
  scanDocumentsMain()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // Never print a PG/S3 error object: it can include connection settings or URLs.
      const safe =
        error instanceof Error &&
        /^(Missing required environment variable: [A-Z_]+|S3_PREFIX |Document antivirus migration |A document scan |Invalid antivirus historical |--limit |--dry-run |Unknown documents:scan)/.test(
          error.message,
        )
          ? error.message
          : storageErrorCode(error);
      console.error(JSON.stringify({ event: 'fatal', error: safe }));
      process.exitCode = 1;
    });
}
