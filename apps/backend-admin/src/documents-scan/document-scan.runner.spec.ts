import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { objectIdentity } from './document-scan.inventory';
import { runDocumentScan } from './document-scan.runner';
import {
  DOCUMENT_SCAN_MAX_BYTES,
  DocumentInventory,
  DocumentObject,
  DocumentScanRecord,
} from './document-scan.types';

function harness(count = 1) {
  const bytes = Buffer.from('%PDF-1.7\nexample');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const objects: DocumentObject[] = Array.from(
    { length: count },
    (_, index) => ({
      bucket: 'documents',
      key: `arrete-cadre/${index + 1}/document.pdf`,
      versionId: `version-${index}`,
      etag: `"etag-${index}"`,
      size: bytes.length,
      modifiedAt: '2026-11-09T08:00:00.000Z',
      latest: true,
      fichierIds: [index + 1],
    }),
  );
  const inventory: DocumentInventory = {
    objects,
    databaseReferences: count,
    externalReferences: 0,
    outOfScopeReferences: 0,
    invalidReferences: 0,
    listedObjects: count,
    excludedObjects: 0,
    versionCoverage: 'all-accessible-versions',
  };
  const records = new Map<string, DocumentScanRecord>();
  const writes: DocumentScanRecord[] = [];
  const journal = {
    start: jest.fn().mockResolvedValue(undefined),
    pending: jest.fn().mockResolvedValue([]),
    previous: jest.fn(async (identity) => records.get(identity)),
    save: jest.fn(async (_runId, record: DocumentScanRecord) => {
      const snapshot = structuredClone(record);
      records.set(record.identity, snapshot);
      writes.push(snapshot);
    }),
    checkpoint: jest.fn().mockResolvedValue(undefined),
  };
  const storage = {
    head: jest.fn(async (object: DocumentObject, signal?: AbortSignal) => {
      if (signal?.aborted)
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return { ...object };
    }),
    open: jest.fn(async () => Readable.from([bytes])),
    quarantine: jest.fn().mockResolvedValue({
      key: '_antivirus-quarantine/sha/document',
      versionId: 'copy-version',
    }),
    verifyQuarantine: jest.fn().mockResolvedValue(undefined),
  };
  const result = {
    status: 'clean' as const,
    bytes: bytes.length,
    sha256,
    engineVersion: '1.4.6',
    signatureVersion: '28000',
    signatureUpdatedAt: '2026-11-09T08:00:00.000Z',
  };
  const scan = jest.fn().mockResolvedValue(result);
  const previous = (
    index: number,
    status: DocumentScanRecord['status'],
    extra: Partial<DocumentScanRecord> = {},
  ) => {
    const object = objects[index];
    records.set(objectIdentity(object), {
      identity: objectIdentity(object),
      object: structuredClone(object),
      status,
      ...extra,
    });
  };
  const run = (
    options: Parameters<typeof runDocumentScan>[3] = {
      execute: true,
      scopeHash: 'scope',
    },
  ) => runDocumentScan(inventory, storage, journal, options, scan);
  return {
    inventory,
    objects,
    bytes,
    sha256,
    result,
    records,
    writes,
    journal,
    storage,
    scan,
    previous,
    run,
  };
}

describe('historical document scan checkpoints and containment', () => {
  it('bounds missing objects by the canary limit without claiming any bytes were scanned', async () => {
    const h = harness(3);
    h.storage.head.mockRejectedValue(
      Object.assign(new Error(), { name: 'NotFound' }),
    );
    expect(
      await h.run({ execute: true, scopeHash: 'scope', limit: 1 }),
    ).toMatchObject({
      status: 'limited',
      processed: 1,
      remaining: 2,
      bytes: 0,
      counts: { missing: 1 },
    });
    expect(h.storage.head).toHaveBeenCalledTimes(1);
    expect(h.scan).not.toHaveBeenCalled();
  });
  it('does not mutate storage or journal in inventory mode', async () => {
    const h = harness();
    expect(await h.run({ execute: false, scopeHash: 'scope' })).toMatchObject({
      status: 'inventory',
      processed: 0,
    });
    expect(h.journal.start).not.toHaveBeenCalled();
    expect(h.storage.head).not.toHaveBeenCalled();
    expect(h.scan).not.toHaveBeenCalled();
  });

  it('resumes matching clean objects and scans only the remaining objects', async () => {
    const h = harness(2);
    h.previous(0, 'clean', { result: h.result });
    expect(await h.run()).toMatchObject({
      status: 'completed',
      resumed: 1,
      processed: 1,
      remaining: 0,
      counts: { clean: 2 },
    });
    expect(h.scan).toHaveBeenCalledTimes(1);
  });

  it('retries previous scanner errors and interrupted scanning records', async () => {
    const h = harness(2);
    h.previous(0, 'error', { reason: 'timeout' });
    h.previous(1, 'scanning');
    expect(await h.run()).toMatchObject({
      resumed: 0,
      processed: 2,
      counts: { clean: 2 },
    });
    expect(h.scan).toHaveBeenCalledTimes(2);
  });

  it('does not count resumed objects against the canary limit', async () => {
    const h = harness(3);
    h.previous(0, 'clean', { result: h.result });
    expect(
      await h.run({ execute: true, scopeHash: 'scope', limit: 1 }),
    ).toMatchObject({
      status: 'limited',
      resumed: 1,
      processed: 1,
      remaining: 1,
    });
    expect(h.scan).toHaveBeenCalledTimes(1);
  });

  it('rejects a changed object before downloading it', async () => {
    const h = harness();
    h.storage.head.mockResolvedValueOnce({
      ...h.objects[0],
      etag: '"new-etag"',
    });
    expect(await h.run()).toMatchObject({ counts: { changed: 1 } });
    expect(h.storage.open).not.toHaveBeenCalled();
    expect(h.storage.quarantine).not.toHaveBeenCalled();
  });

  it('does not certify clean bytes if the source changes during the scan', async () => {
    const h = harness();
    h.storage.head
      .mockResolvedValueOnce(h.objects[0])
      .mockResolvedValueOnce({ ...h.objects[0], etag: '"new-etag"' });
    expect(await h.run()).toMatchObject({ counts: { changed: 1 } });
    expect(h.records.get(objectIdentity(h.objects[0]))?.reason).toBe(
      'object_changed_during_scan',
    );
  });

  it('records oversize documents as unscannable without downloading them', async () => {
    const h = harness();
    h.objects[0].size = DOCUMENT_SCAN_MAX_BYTES + 1;
    expect(await h.run()).toMatchObject({ counts: { unscannable: 1 } });
    expect(h.storage.open).not.toHaveBeenCalled();
    expect(h.scan).not.toHaveBeenCalled();
  });

  it('never accepts a clean verdict with an incomplete hash or byte count', async () => {
    const h = harness();
    h.scan.mockResolvedValue({ ...h.result, bytes: h.bytes.length - 1 });
    expect(await h.run()).toMatchObject({ counts: { error: 1 } });
    expect(h.records.get(objectIdentity(h.objects[0]))?.reason).toBe(
      'incomplete_stream',
    );
  });

  it('stops immediately when containment of a positive document fails', async () => {
    const h = harness(2);
    h.scan.mockResolvedValue({
      ...h.result,
      status: 'infected',
      signature: 'Win.Test.EICAR_HDB-1',
    });
    h.storage.quarantine.mockRejectedValue(new Error('ACL refused'));
    expect(await h.run()).toMatchObject({
      status: 'failed',
      processed: 1,
      remaining: 1,
      counts: { quarantine_failed: 1 },
    });
    expect(h.scan).toHaveBeenCalledTimes(1);
    expect(h.records.get(objectIdentity(h.objects[0]))?.result).toMatchObject({
      status: 'infected',
      sha256: h.sha256,
    });
  });

  it('durably saves a positive verdict before touching ACLs or copying bytes', async () => {
    const h = harness();
    h.scan.mockResolvedValue({ ...h.result, status: 'infected' });
    h.storage.quarantine.mockImplementation(async () => {
      expect(h.records.get(objectIdentity(h.objects[0]))?.result).toMatchObject(
        { status: 'infected', sha256: h.sha256 },
      );
      return {
        key: '_antivirus-quarantine/sha/document',
        versionId: 'copy-version',
      };
    });
    expect(await h.run()).toMatchObject({ counts: { infected: 1 } });
    expect(h.storage.quarantine).toHaveBeenCalledTimes(1);
  });

  it('retries containment of a known positive without rescanning or losing its verdict', async () => {
    const h = harness();
    h.previous(0, 'quarantine_failed', {
      result: { ...h.result, status: 'infected' },
      reason: 'quarantine_failed:AbortError',
    });
    expect(await h.run()).toMatchObject({ counts: { infected: 1 } });
    expect(h.scan).not.toHaveBeenCalled();
    expect(h.storage.quarantine).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: 'version-0' }),
      h.sha256,
      expect.anything(),
    );
  });

  it('finishes containment after a positive verdict even if an interrupt arrives', async () => {
    const h = harness(2);
    const abort = new AbortController();
    h.scan.mockImplementation(async () => {
      abort.abort();
      return { ...h.result, status: 'infected' };
    });
    expect(
      await h.run({ execute: true, scopeHash: 'scope', signal: abort.signal }),
    ).toMatchObject({
      status: 'interrupted',
      processed: 1,
      remaining: 1,
      counts: { infected: 1 },
    });
    expect(h.storage.quarantine).toHaveBeenCalledTimes(1);
    const signal = h.storage.quarantine.mock.calls[0][2] as
      | AbortSignal
      | undefined;
    expect(signal?.aborted).not.toBe(true);
  });

  it('contains a pending positive even when it no longer appears in the current listing', async () => {
    const h = harness();
    h.previous(0, 'quarantine_pending', {
      result: { ...h.result, status: 'infected' },
    });
    h.journal.pending.mockResolvedValue([...h.records.values()]);
    h.inventory.objects = [];
    expect(await h.run()).toMatchObject({
      processed: 1,
      counts: { infected: 1 },
    });
    expect(h.scan).not.toHaveBeenCalled();
    expect(h.storage.quarantine).toHaveBeenCalledTimes(1);
  });

  it('reapplies confinement when an earlier private ACL or copy cannot be verified', async () => {
    const h = harness();
    h.previous(0, 'infected', {
      result: { ...h.result, status: 'infected' },
      quarantineKey: '_antivirus-quarantine/old',
    });
    h.storage.verifyQuarantine.mockRejectedValue(
      new Error('copy missing or ACL public'),
    );
    expect(await h.run()).toMatchObject({ counts: { infected: 1 } });
    expect(h.scan).not.toHaveBeenCalled();
    expect(h.storage.verifyQuarantine).toHaveBeenCalledTimes(1);
    expect(h.storage.quarantine).toHaveBeenCalledTimes(1);
  });

  it('does not lose a known positive if its first HEAD fails on resume', async () => {
    const h = harness();
    h.previous(0, 'infected', {
      result: { ...h.result, status: 'infected' },
      quarantineKey: '_antivirus-quarantine/old',
    });
    h.storage.head.mockRejectedValue(new Error('S3 temporarily unavailable'));
    expect(await h.run()).toMatchObject({
      status: 'failed',
      counts: { quarantine_failed: 1 },
    });
    expect(h.records.get(objectIdentity(h.objects[0]))?.result).toMatchObject({
      status: 'infected',
      sha256: h.sha256,
    });
    expect(h.scan).not.toHaveBeenCalled();
  });

  it('still contains a detected threat if persisting its verdict fails, then stops', async () => {
    const h = harness(2);
    h.scan.mockResolvedValue({ ...h.result, status: 'infected' });
    const save = h.journal.save.getMockImplementation();
    h.journal.save.mockImplementation(async (runId, record) => {
      if (record.result?.status === 'infected')
        throw new Error('Database unavailable');
      await save(runId, record);
    });
    expect(await h.run()).toMatchObject({ status: 'failed' });
    expect(h.storage.quarantine).toHaveBeenCalledTimes(1);
    expect(h.scan).toHaveBeenCalledTimes(1);
  });

  it('persists a positive before making any post-scan storage request', async () => {
    const h = harness();
    let detected = false;
    h.scan.mockImplementation(async () => {
      detected = true;
      return { ...h.result, status: 'infected' };
    });
    h.storage.head.mockImplementation(async (object) => {
      if (detected)
        expect(h.records.get(objectIdentity(object))?.result).toMatchObject({
          status: 'infected',
        });
      return object;
    });
    expect(await h.run()).toMatchObject({ counts: { infected: 1 } });
  });

  it('counts a pending version and a matching unversioned inventory entry only once', async () => {
    const h = harness();
    const versioned = { ...h.objects[0] };
    h.previous(0, 'quarantine_pending', {
      result: { ...h.result, status: 'infected' },
    });
    h.journal.pending.mockResolvedValue([...h.records.values()]);
    h.objects[0].versionId = undefined;
    h.storage.head.mockResolvedValue(versioned);
    expect(await h.run()).toMatchObject({
      processed: 1,
      resumed: 0,
      remaining: 0,
      counts: { infected: 1 },
      inventory: { candidates: 1 },
    });
    expect(h.storage.quarantine).toHaveBeenCalledTimes(1);
  });
});
