import { Client } from 'pg';
import {
  DocumentScanJournal,
  DocumentScanRecord,
  DocumentScanReport,
} from './document-scan.types';

/** A separate audit ledger deliberately leaves fichier and its publication triggers untouched. */
export class PostgresDocumentScanJournal implements DocumentScanJournal {
  constructor(
    private readonly client: Client,
    private readonly scopeHash?: string,
  ) {}

  async pending(): Promise<DocumentScanRecord[]> {
    const { rows } = await this.client.query(
      `
      SELECT result.identity FROM document_scan_result result
      JOIN document_scan_run run ON run.id = result.run_id
      WHERE run.scope_hash = $1 AND result.status IN ('quarantine_pending', 'quarantine_failed')
      ORDER BY result.updated_at
    `,
      [this.scopeHash],
    );
    const records: DocumentScanRecord[] = [];
    for (const row of rows) records.push(await this.previous(row.identity));
    return records;
  }

  async start(report: DocumentScanReport): Promise<void> {
    await this.client.query(
      'INSERT INTO document_scan_run (id, scope_hash, status, report) VALUES ($1, $2, $3, $4)',
      [report.runId, report.scopeHash, report.status, JSON.stringify(report)],
    );
  }

  async previous(identity: string): Promise<DocumentScanRecord | undefined> {
    const { rows } = await this.client.query(
      'SELECT * FROM document_scan_result WHERE identity = $1',
      [identity],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      identity,
      status: row.status,
      reason: row.reason,
      object: {
        bucket: row.bucket,
        key: row.object_key,
        versionId: row.version_id || undefined,
        etag: row.etag || undefined,
        size: Number(row.object_size),
        modifiedAt: row.object_modified_at?.toISOString(),
        latest: true,
        fichierIds: row.fichier_ids,
      },
      result: row.result,
      quarantineKey: row.quarantine_key || undefined,
      quarantineVersionId: row.quarantine_version_id || undefined,
    };
  }

  async save(runId: string, record: DocumentScanRecord): Promise<void> {
    const object = record.object;
    const result = record.result;
    await this.client.query(
      `
      INSERT INTO document_scan_result (
        identity, run_id, bucket, object_key, version_id, etag, object_size,
        object_modified_at, fichier_ids, status, sha256, signature, engine_version,
        signature_version, signature_updated_at, reason, quarantine_key, quarantine_version_id, result
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (identity) DO UPDATE SET
        run_id = EXCLUDED.run_id, fichier_ids = EXCLUDED.fichier_ids, status = EXCLUDED.status,
        sha256 = EXCLUDED.sha256, signature = EXCLUDED.signature, engine_version = EXCLUDED.engine_version,
        signature_version = EXCLUDED.signature_version, signature_updated_at = EXCLUDED.signature_updated_at,
        reason = EXCLUDED.reason, quarantine_key = EXCLUDED.quarantine_key,
        quarantine_version_id = EXCLUDED.quarantine_version_id, result = EXCLUDED.result,
        attempts = document_scan_result.attempts + CASE WHEN EXCLUDED.status = 'scanning' THEN 1 ELSE 0 END,
        updated_at = now()
    `,
      [
        record.identity,
        runId,
        object.bucket,
        object.key,
        object.versionId ?? null,
        object.etag ?? null,
        object.size,
        object.modifiedAt ?? null,
        object.fichierIds,
        record.status,
        result?.sha256 ?? null,
        result?.signature ?? null,
        result?.engineVersion ?? null,
        result?.signatureVersion ?? null,
        result?.signatureUpdatedAt ?? null,
        record.reason ?? result?.reason ?? null,
        record.quarantineKey ?? null,
        record.quarantineVersionId ?? null,
        JSON.stringify(result ?? {}),
      ],
    );
  }

  async checkpoint(report: DocumentScanReport): Promise<void> {
    await this.client.query(
      'UPDATE document_scan_run SET status = $2, report = $3, updated_at = now() WHERE id = $1',
      [report.runId, report.status, JSON.stringify(report)],
    );
  }
}
