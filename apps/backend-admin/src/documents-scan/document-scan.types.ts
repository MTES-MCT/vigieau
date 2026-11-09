import type { Readable } from 'node:stream';
import type { ScanResult } from '../antivirus/antivirus.core';

export const DOCUMENT_SCAN_MAX_BYTES = 32 * 1024 * 1024;

export interface DocumentObject {
  bucket: string;
  key: string;
  versionId?: string;
  etag?: string;
  size: number;
  modifiedAt?: string;
  latest: boolean;
  fichierIds: number[];
}

export interface DocumentInventory {
  objects: DocumentObject[];
  databaseReferences: number;
  externalReferences: number;
  outOfScopeReferences: number;
  invalidReferences: number;
  listedObjects: number;
  excludedObjects: number;
  versionCoverage:
    | 'all-accessible-versions'
    | 'current-only-access-denied'
    | 'current-only-unsupported';
}

export type DocumentScanStatus =
  | ScanResult['status']
  | 'scanning'
  | 'changed'
  | 'missing'
  | 'quarantine_pending'
  | 'quarantine_failed';

export interface DocumentScanRecord {
  identity: string;
  object: DocumentObject;
  status: DocumentScanStatus;
  result?: ScanResult;
  reason?: string;
  quarantineKey?: string;
  quarantineVersionId?: string;
}

export interface DocumentScanReport {
  runId: string;
  execute: boolean;
  status:
    | 'inventory'
    | 'running'
    | 'completed'
    | 'limited'
    | 'interrupted'
    | 'failed';
  scopeHash: string;
  startedAt: string;
  finishedAt?: string;
  inventory: Omit<DocumentInventory, 'objects'> & { candidates: number };
  processed: number;
  resumed: number;
  remaining: number;
  bytes: number;
  counts: Partial<Record<DocumentScanStatus, number>>;
  error?: string;
}

export interface DocumentScanStorage {
  head(object: DocumentObject, signal?: AbortSignal): Promise<DocumentObject>;
  open(object: DocumentObject, signal?: AbortSignal): Promise<Readable>;
  quarantine(
    object: DocumentObject,
    sha256: string,
    signal?: AbortSignal,
  ): Promise<{ key: string; versionId?: string }>;
  verifyQuarantine?(
    record: DocumentScanRecord,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface DocumentScanJournal {
  start(report: DocumentScanReport): Promise<void>;
  previous(identity: string): Promise<DocumentScanRecord | undefined>;
  save(runId: string, record: DocumentScanRecord): Promise<void>;
  checkpoint(report: DocumentScanReport): Promise<void>;
  pending?(): Promise<DocumentScanRecord[]>;
}
