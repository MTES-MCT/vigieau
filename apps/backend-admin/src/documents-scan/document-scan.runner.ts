import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  ScanResult,
  ScanOptions,
  scanDocumentStream,
} from '../antivirus/antivirus.core';
import { objectIdentity, sameObject } from './document-scan.inventory';
import { storageErrorCode } from './document-scan.storage';
import {
  DOCUMENT_SCAN_MAX_BYTES,
  DocumentInventory,
  DocumentScanJournal,
  DocumentScanRecord,
  DocumentScanReport,
  DocumentScanStorage,
} from './document-scan.types';

export interface DocumentScanRunOptions {
  execute: boolean;
  scopeHash: string;
  limit?: number;
  rescan?: boolean;
  signal?: AbortSignal;
  scannerOptions?: ScanOptions;
  log?: (event: Record<string, unknown>) => void;
}

const TERMINAL = new Set(['clean', 'infected', 'unscannable']);
const SCANNER_UNAVAILABLE = new Set([
  'scanner_unavailable',
  'stale_signatures',
  'invalid_version',
]);

export async function runDocumentScan(
  inventory: DocumentInventory,
  storage: DocumentScanStorage,
  journal: DocumentScanJournal,
  options: DocumentScanRunOptions,
  scan: (
    stream: Readable,
    options: ScanOptions,
  ) => Promise<ScanResult> = scanDocumentStream,
): Promise<DocumentScanReport> {
  const { objects: inventoryObjects, ...inventorySummary } = inventory;
  const pending = options.execute ? ((await journal.pending?.()) ?? []) : [];
  const pendingMap = new Map(
    pending.map((record) => [record.identity, record]),
  );
  const objects = [
    ...pending.map((record) => record.object),
    ...inventoryObjects.filter(
      (object) =>
        !pendingMap.has(objectIdentity(object)) &&
        !pending.some(
          (record) =>
            (object.etag || object.versionId) &&
            sameObject(object, record.object),
        ),
    ),
  ];
  const report: DocumentScanReport = {
    runId: randomUUID(),
    execute: options.execute,
    status: options.execute ? 'running' : 'inventory',
    scopeHash: options.scopeHash,
    startedAt: new Date().toISOString(),
    inventory: { ...inventorySummary, candidates: objects.length },
    processed: 0,
    resumed: 0,
    remaining: objects.length,
    bytes: 0,
    counts: {},
  };
  if (!options.execute)
    return { ...report, finishedAt: new Date().toISOString() };
  await journal.start(report);
  const confine = async (record: DocumentScanRecord): Promise<boolean> => {
    // Persist the detection BEFORE changing storage. A crash must never turn a
    // previously positive document into a new, potentially clean scan decision.
    record.status = 'quarantine_pending';
    let auditFailed = false;
    try {
      await journal.save(report.runId, record);
    } catch {
      // A database outage must not leave known malware publicly accessible.
      auditFailed = true;
      options.log?.({
        event: 'audit_failure',
        identity: record.identity,
        status: 'quarantine_pending',
      });
    }
    try {
      // Once a positive is confirmed, finish confinement even on operator SIGTERM.
      // This remains bounded independently from the scan cancellation signal.
      const quarantine = await storage.quarantine(
        record.object,
        record.result.sha256,
        AbortSignal.timeout(120_000),
      );
      record.quarantineKey = quarantine.key;
      record.quarantineVersionId = quarantine.versionId;
      record.status = 'infected';
      if (auditFailed) record.reason = 'audit_checkpoint_failed';
      return !auditFailed;
    } catch (error) {
      record.status = 'quarantine_failed';
      record.reason = `quarantine_failed:${storageErrorCode(error)}`;
      return false;
    }
  };
  try {
    for (const candidate of objects) {
      if (options.signal?.aborted) {
        report.status = 'interrupted';
        break;
      }
      if (
        options.limit !== undefined &&
        report.processed >= options.limit &&
        !pendingMap.has(objectIdentity(candidate))
      ) {
        report.status = 'limited';
        break;
      }
      let record: DocumentScanRecord = pendingMap.get(
        objectIdentity(candidate),
      ) ?? {
        identity: objectIdentity(candidate),
        object: candidate,
        status: 'scanning',
      };
      let fatal = false;
      try {
        const known = await journal.previous(record.identity);
        if (known?.result?.status === 'infected')
          record = { ...known, object: candidate };
        const object = await storage.head(candidate, options.signal);
        // DB-only references have no S3 metadata yet: their declared size is not a concurrency token.
        if (
          (candidate.etag || candidate.versionId || candidate.modifiedAt) &&
          !sameObject(candidate, object)
        ) {
          record.status =
            record.result?.status === 'infected'
              ? 'quarantine_failed'
              : 'changed';
          if (record.status === 'quarantine_failed') fatal = true;
          record.reason = 'object_changed_since_inventory';
        } else {
          record = {
            identity: objectIdentity(object),
            object,
            status: 'scanning',
          };
          const previous = await journal.previous(record.identity);
          let verifiedPositive = false;
          if (
            previous?.status === 'infected' &&
            previous.quarantineKey &&
            storage.verifyQuarantine
          ) {
            try {
              await storage.verifyQuarantine(
                { ...previous, object },
                AbortSignal.timeout(120_000),
              );
              verifiedPositive = true;
            } catch {
              /* Re-apply confinement below; never assume an ACL stayed private. */
            }
          }
          const positive =
            previous?.result?.status === 'infected' &&
            /^[a-f0-9]{64}$/.test(previous.result.sha256 ?? '') &&
            previous.result.bytes === object.size;
          if (
            previous &&
            ((!options.rescan &&
              TERMINAL.has(previous.status) &&
              previous.status !== 'infected') ||
              verifiedPositive)
          ) {
            report.resumed++;
            report.remaining--;
            report.counts[previous.status] =
              (report.counts[previous.status] ?? 0) + 1;
            await journal.checkpoint(report);
            continue;
          }
          if (positive) {
            record = { ...previous, object };
            fatal = !(await confine(record));
          } else {
            // Completed records never consume the canary budget; an interrupted run can resume it.
            if (
              options.limit !== undefined &&
              report.processed >= options.limit
            ) {
              report.status = 'limited';
              break;
            }
            await journal.save(report.runId, record);
            if (!Number.isSafeInteger(object.size) || object.size < 0) {
              record.status = 'error';
              record.reason = 'invalid_object_size';
            } else if (object.size > DOCUMENT_SCAN_MAX_BYTES) {
              record.status = 'unscannable';
              record.result = {
                status: 'unscannable',
                reason: 'size_limit',
                bytes: 0,
              };
            } else {
              const body = await storage.open(object, options.signal);
              try {
                record.result = await scan(body, {
                  ...options.scannerOptions,
                  maxBytes: DOCUMENT_SCAN_MAX_BYTES,
                  timeoutMs: options.scannerOptions?.timeoutMs ?? 60_000,
                  signal: options.signal,
                });
              } finally {
                body.destroy();
              }
              report.bytes += record.result.bytes;
              record.status = record.result.status;
              record.reason = record.result.reason;
              if (
                ['clean', 'infected'].includes(record.status) &&
                (!/^[a-f0-9]{64}$/.test(record.result.sha256 ?? '') ||
                  record.result.bytes !== object.size)
              ) {
                record.status = 'error';
                record.reason = 'incomplete_stream';
              }
              if (record.status === 'infected') {
                fatal = !(await confine(record));
              } else if (record.status === 'clean') {
                if (
                  !sameObject(
                    object,
                    await storage.head(object, options.signal),
                  )
                ) {
                  record.status = 'changed';
                  record.reason = 'object_changed_during_scan';
                }
              }
              if (
                record.status === 'error' &&
                SCANNER_UNAVAILABLE.has(record.reason)
              )
                fatal = true;
            }
          }
        }
      } catch (error) {
        const code = storageErrorCode(error);
        const positive = record.result?.status === 'infected';
        record.status = positive
          ? 'quarantine_failed'
          : ['NoSuchKey', 'NoSuchVersion', 'NotFound'].includes(code)
            ? 'missing'
            : code === 'PreconditionFailed'
              ? 'changed'
              : 'error';
        record.reason = options.signal?.aborted ? 'aborted' : code;
        if (positive) fatal = true;
      }
      try {
        await journal.save(report.runId, record);
      } catch {
        fatal = true;
        record.reason = 'audit_checkpoint_failed';
      }
      report.processed++;
      report.remaining--;
      report.counts[record.status] = (report.counts[record.status] ?? 0) + 1;
      options.log?.({
        event: 'document',
        identity: record.identity,
        fichierIds: record.object.fichierIds,
        status: record.status,
        reason: record.reason ?? record.result?.reason,
        bytes: record.result?.bytes ?? 0,
      });
      if (fatal) {
        report.status = 'failed';
        report.error = record.reason;
      }
      if (options.signal?.aborted && !fatal) report.status = 'interrupted';
      await journal.checkpoint(report);
      if (report.status !== 'running') break;
    }
    if (report.status === 'running') report.status = 'completed';
  } catch (error) {
    report.status = options.signal?.aborted ? 'interrupted' : 'failed';
    report.error = storageErrorCode(error);
  }
  report.finishedAt = new Date().toISOString();
  try {
    await journal.checkpoint(report);
  } catch {
    report.status = 'failed';
    report.error = 'audit_checkpoint_failed';
  }
  return report;
}
