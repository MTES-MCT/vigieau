import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectAclCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  documentKeyFromUrl,
  isDocumentKey,
  isDocumentPrefix,
  publicObjectUrl,
  sameObject,
  scopedRelativeKey,
  sha256Text,
} from './document-scan.inventory';
import {
  DOCUMENT_SCAN_MAX_BYTES,
  DocumentInventory,
  DocumentObject,
  DocumentScanStorage,
  DocumentScanRecord,
} from './document-scan.types';

export interface DocumentStorageConfig {
  bucket: string;
  prefix: string;
  publicBaseUrl: string;
}

export interface FileReference {
  id: number;
  url: string;
  size: number;
}

export function storageErrorCode(error: unknown): string {
  const name =
    (error as { name?: string; Code?: string })?.name ||
    (error as { Code?: string })?.Code;
  return typeof name === 'string' && /^[A-Za-z0-9_]+$/.test(name)
    ? name
    : 'StorageError';
}

function isDenied(error: unknown): boolean {
  return (
    ['AccessDenied', 'Forbidden', 'AccessDeniedException'].includes(
      storageErrorCode(error),
    ) ||
    (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode === 403
  );
}

function objectFromMetadata(
  object: DocumentObject,
  metadata: {
    VersionId?: string;
    ETag?: string;
    ContentLength?: number;
    LastModified?: Date;
  },
): DocumentObject {
  return {
    ...object,
    versionId: metadata.VersionId || object.versionId,
    etag: metadata.ETag,
    size: Number(metadata.ContentLength),
    modifiedAt: metadata.LastModified?.toISOString(),
  };
}

function timeoutSignal(signal?: AbortSignal, timeoutMs = 30_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class S3DocumentStorage implements DocumentScanStorage {
  constructor(
    private readonly client: S3Client,
    private readonly config: DocumentStorageConfig,
  ) {
    // Validate the public origin before any request can be made to it.
    publicObjectUrl(config.publicBaseUrl, 'validation-only');
  }

  async inventory(
    references: FileReference[],
    signal?: AbortSignal,
  ): Promise<DocumentInventory> {
    const referenceMap = new Map<string, FileReference[]>();
    const report: DocumentInventory = {
      objects: [],
      databaseReferences: references.length,
      externalReferences: 0,
      outOfScopeReferences: 0,
      invalidReferences: 0,
      listedObjects: 0,
      excludedObjects: 0,
      versionCoverage: 'all-accessible-versions',
    };
    for (const reference of references) {
      const parsed = documentKeyFromUrl(
        reference.url,
        this.config.publicBaseUrl,
      );
      if (parsed.kind === 'external') {
        report.externalReferences++;
        continue;
      }
      if (parsed.kind === 'invalid') {
        report.invalidReferences++;
        continue;
      }
      if (scopedRelativeKey(parsed.key, this.config.prefix) === null) {
        report.outOfScopeReferences++;
        continue;
      }
      const rows = referenceMap.get(parsed.key) ?? [];
      rows.push(reference);
      referenceMap.set(parsed.key, rows);
    }

    const current = new Map<string, DocumentObject>();
    const older = new Map<string, DocumentObject>();
    const bases =
      this.config.prefix && !this.config.prefix.startsWith('/')
        ? [this.config.prefix, '/' + this.config.prefix]
        : this.config.prefix
          ? [this.config.prefix]
          : ['', '/'];
    // Avoid recursively listing years of generated cartographic artifacts.
    const listings: Array<{
      Prefix: string;
      Delimiter?: string;
      exactKey?: string;
    }> = bases.flatMap((base) => [
      { Prefix: base, Delimiter: '/' },
      ...['arrete-cadre/', 'arrete-restriction/', 'arrete-municipal/'].map(
        (folder) => ({ Prefix: base + folder }),
      ),
    ]);
    for (const key of referenceMap.keys()) {
      if (
        !listings.some(
          (listing) => !listing.Delimiter && key.startsWith(listing.Prefix),
        )
      ) {
        listings.push({ Prefix: key, exactKey: key });
      }
    }
    const discovered = new Set(listings.map((listing) => listing.Prefix));
    const discoverPrefixes = (prefixes: Array<{ Prefix?: string }> = []) => {
      for (const { Prefix: prefix } of prefixes) {
        if (
          !prefix ||
          discovered.has(prefix) ||
          !isDocumentPrefix(prefix, this.config.prefix)
        )
          continue;
        discovered.add(prefix);
        listings.push({ Prefix: prefix, Delimiter: '/' });
      }
    };
    for (const listing of listings) {
      let token: string | undefined;
      do {
        const page = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.config.bucket,
            Prefix: listing.Prefix,
            Delimiter: listing.Delimiter,
            ContinuationToken: token,
            MaxKeys: 1000,
          }),
          { abortSignal: timeoutSignal(signal) },
        );
        discoverPrefixes(page.CommonPrefixes);
        for (const entry of page.Contents ?? []) {
          if (!entry.Key) continue;
          if (listing.exactKey && entry.Key !== listing.exactKey) continue;
          report.listedObjects++;
          if (
            !isDocumentKey(
              entry.Key,
              this.config.prefix,
              referenceMap.has(entry.Key),
            )
          ) {
            report.excludedObjects++;
            continue;
          }
          current.set(entry.Key, {
            bucket: this.config.bucket,
            key: entry.Key,
            etag: entry.ETag,
            size: Number(entry.Size),
            modifiedAt: entry.LastModified?.toISOString(),
            latest: true,
            fichierIds: (referenceMap.get(entry.Key) ?? []).map(
              (row) => row.id,
            ),
          });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && !token)
          throw new Error('Invalid S3 inventory continuation');
      } while (token);
    }

    // Version enumeration is best effort only for providers denying this permission.
    // Other errors are not hidden as successful inventory.
    try {
      for (const listing of listings) {
        let keyMarker: string | undefined;
        let versionMarker: string | undefined;
        do {
          const page = await this.client.send(
            new ListObjectVersionsCommand({
              Bucket: this.config.bucket,
              Prefix: listing.Prefix,
              Delimiter: listing.Delimiter,
              KeyMarker: keyMarker,
              VersionIdMarker: versionMarker,
              MaxKeys: 1000,
            }),
            { abortSignal: timeoutSignal(signal) },
          );
          discoverPrefixes(page.CommonPrefixes);
          for (const entry of page.Versions ?? []) {
            if (listing.exactKey && entry.Key !== listing.exactKey) continue;
            if (
              !entry.Key ||
              !entry.VersionId ||
              !isDocumentKey(
                entry.Key,
                this.config.prefix,
                referenceMap.has(entry.Key),
              )
            )
              continue;
            const object: DocumentObject = {
              bucket: this.config.bucket,
              key: entry.Key,
              versionId: entry.VersionId,
              etag: entry.ETag,
              size: Number(entry.Size),
              modifiedAt: entry.LastModified?.toISOString(),
              latest: entry.IsLatest === true,
              fichierIds: (referenceMap.get(entry.Key) ?? []).map(
                (row) => row.id,
              ),
            };
            if (object.latest) current.set(entry.Key, object);
            else
              older.set(JSON.stringify([entry.Key, entry.VersionId]), object);
          }
          keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
          versionMarker = page.IsTruncated
            ? page.NextVersionIdMarker
            : undefined;
          if (page.IsTruncated && !keyMarker)
            throw new Error('Invalid S3 version continuation');
        } while (keyMarker);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (isDenied(error))
        report.versionCoverage = 'current-only-access-denied';
      else if (
        ['NotImplemented', 'NotSupported', 'MethodNotAllowed'].includes(
          storageErrorCode(error),
        )
      ) {
        report.versionCoverage = 'current-only-unsupported';
      } else throw error;
    }

    // Include DB references whose current S3 object is absent, so they become explicit missing results.
    for (const [key, rows] of referenceMap) {
      if (!current.has(key))
        current.set(key, {
          bucket: this.config.bucket,
          key,
          size: Number(rows[0].size),
          latest: true,
          fichierIds: rows.map((row) => row.id),
        });
    }
    report.objects = [...current.values(), ...older.values()].sort(
      (a, b) =>
        a.key.localeCompare(b.key) ||
        String(a.versionId ?? '').localeCompare(String(b.versionId ?? '')),
    );
    return report;
  }

  async head(
    object: DocumentObject,
    signal?: AbortSignal,
  ): Promise<DocumentObject> {
    const metadata = await this.client.send(
      new HeadObjectCommand({
        Bucket: object.bucket,
        Key: object.key,
        ...(object.versionId ? { VersionId: object.versionId } : {}),
      }),
      { abortSignal: timeoutSignal(signal) },
    );
    return objectFromMetadata(object, metadata);
  }

  async open(object: DocumentObject, signal?: AbortSignal): Promise<Readable> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: object.bucket,
        Key: object.key,
        ...(object.versionId ? { VersionId: object.versionId } : {}),
        ...(object.etag ? { IfMatch: object.etag } : {}),
      }),
      { abortSignal: timeoutSignal(signal, 75_000) },
    );
    if (!sameObject(object, objectFromMetadata(object, response))) {
      (response.Body as Readable | undefined)?.destroy();
      throw Object.assign(new Error('Object changed while opening'), {
        name: 'PreconditionFailed',
      });
    }
    if (!(response.Body instanceof Readable))
      throw new Error('S3 object body is not a Node stream');
    return response.Body;
  }

  private async assertPrivate(
    key: string,
    versionId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch(
      publicObjectUrl(this.config.publicBaseUrl, key, versionId),
      {
        method: 'GET',
        redirect: 'manual',
        signal: timeoutSignal(signal),
        headers: { Range: 'bytes=0-0', 'Cache-Control': 'no-cache' },
      },
    );
    await response.body?.cancel();
    if (![403, 404].includes(response.status)) {
      throw new Error(
        `Quarantine access verification failed (${response.status})`,
      );
    }
  }

  async verifyQuarantine(
    record: DocumentScanRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!record.quarantineKey) throw new Error('Missing quarantine evidence');
    const copy = await this.head(
      {
        ...record.object,
        key: record.quarantineKey,
        versionId: record.quarantineVersionId,
        etag: undefined,
        modifiedAt: undefined,
      },
      signal,
    );
    if (copy.size !== record.object.size)
      throw new Error('Quarantine copy size mismatch');
    if (
      record.quarantineVersionId &&
      copy.versionId !== record.quarantineVersionId
    ) {
      throw new Error('Quarantine copy version mismatch');
    }
    // A null/unversioned object can be replaced without changing its URL.
    if (!copy.versionId || copy.versionId === 'null') {
      const body = await this.open(copy, signal);
      const hash = createHash('sha256');
      let bytes = 0;
      try {
        for await (const chunk of body) {
          bytes += chunk.length;
          if (bytes > DOCUMENT_SCAN_MAX_BYTES)
            throw new Error('Quarantine copy exceeds limit');
          hash.update(chunk);
        }
      } finally {
        body.destroy();
      }
      if (
        bytes !== record.object.size ||
        hash.digest('hex') !== record.result?.sha256
      ) {
        throw new Error('Quarantine copy digest mismatch');
      }
    }
    await this.assertPrivate(
      record.object.key,
      record.object.versionId,
      signal,
    );
    let latest: DocumentObject | undefined;
    try {
      latest = await this.head(
        { ...record.object, versionId: undefined },
        signal,
      );
    } catch (error) {
      if (
        !['NoSuchKey', 'NoSuchVersion', 'NotFound'].includes(
          storageErrorCode(error),
        )
      )
        throw error;
    }
    if (latest && sameObject(record.object, latest))
      await this.assertPrivate(record.object.key, undefined, signal);
    await this.assertPrivate(
      record.quarantineKey,
      record.quarantineVersionId,
      signal,
    );
    await this.assertPrivate(record.quarantineKey, undefined, signal);
  }

  async quarantine(
    object: DocumentObject,
    sha256: string,
    signal?: AbortSignal,
  ): Promise<{ key: string; versionId?: string }> {
    if (!/^[a-f0-9]{64}$/.test(sha256))
      throw new Error('A complete SHA-256 is required for quarantine');
    const before = await this.head(object, signal);
    if (!sameObject(object, before))
      throw new Error('Object changed before quarantine');
    const versionId = before.versionId;

    // Revoke access before copying. Never delete or overwrite the source bytes.
    await this.client.send(
      new PutObjectAclCommand({
        Bucket: object.bucket,
        Key: object.key,
        ACL: 'private',
        ...(versionId ? { VersionId: versionId } : {}),
      }),
      { abortSignal: timeoutSignal(signal) },
    );
    // Without versioning, S3 ACL changes have no If-Match primitive. If a concurrent
    // replacement happened, retain the restrictive ACL and stop; never republish it.
    if (!sameObject(before, await this.head(before, signal)))
      throw new Error('Source changed while revoking access');
    await this.assertPrivate(object.key, versionId, signal);
    if (object.latest) {
      const latest = await this.head(
        { ...object, versionId: undefined },
        signal,
      );
      if (sameObject(before, latest))
        await this.assertPrivate(object.key, undefined, signal);
    }

    const key = `${this.config.prefix}_antivirus-quarantine/${sha256}/${sha256Text(JSON.stringify([object.key, versionId ?? object.etag]))}`;
    const source =
      `${encodeURIComponent(object.bucket)}/${object.key.split('/').map(encodeURIComponent).join('/')}` +
      (versionId ? `?versionId=${encodeURIComponent(versionId)}` : '');
    const copied = await this.client.send(
      new CopyObjectCommand({
        Bucket: object.bucket,
        Key: key,
        CopySource: source,
        ACL: 'private',
        ...(object.etag ? { CopySourceIfMatch: object.etag } : {}),
        MetadataDirective: 'COPY',
      }),
      { abortSignal: timeoutSignal(signal) },
    );
    const copyObject: DocumentObject = {
      ...object,
      key,
      versionId: copied.VersionId,
      etag: undefined,
      modifiedAt: undefined,
      latest: true,
      fichierIds: [],
    };
    const copyHead = await this.head(copyObject, signal);
    if (copyHead.size !== object.size)
      throw new Error('Quarantine copy size mismatch');
    const body = await this.open(copyHead, signal);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of body) {
        bytes += chunk.length;
        if (bytes > DOCUMENT_SCAN_MAX_BYTES)
          throw new Error('Quarantine copy exceeds limit');
        hash.update(chunk);
      }
    } finally {
      body.destroy();
    }
    if (bytes !== object.size || hash.digest('hex') !== sha256)
      throw new Error('Quarantine copy digest mismatch');
    await this.assertPrivate(key, copyHead.versionId, signal);
    await this.assertPrivate(key, undefined, signal);
    if (!sameObject(before, await this.head(before, signal)))
      throw new Error('Source changed during quarantine');
    return { key, versionId: copyHead.versionId };
  }
}
