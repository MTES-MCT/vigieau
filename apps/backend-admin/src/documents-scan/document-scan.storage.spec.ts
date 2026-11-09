import { S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3DocumentStorage } from './document-scan.storage';
import { DocumentObject } from './document-scan.types';

describe('document S3 inventory and reversible quarantine', () => {
  const original: DocumentObject = {
    bucket: 'documents',
    key: '/arrete-cadre/file.pdf',
    versionId: 'v1',
    etag: 'e1',
    size: 4,
    latest: true,
    fichierIds: [1],
  };
  const body = Buffer.from('test');
  const hash = createHash('sha256').update(body).digest('hex');
  const config = {
    bucket: 'documents',
    prefix: '',
    publicBaseUrl: 'https://documents.example.test/',
  };
  const metadata = { VersionId: 'v1', ETag: 'e1', ContentLength: 4 };
  afterEach(() => jest.restoreAllMocks());

  it('does not enumerate S3 once per missing DB reference or recursively list a directory reference', async () => {
    const send = jest.fn(async () => ({}));
    const storage = new S3DocumentStorage({ send } as unknown as S3Client, {
      ...config,
      prefix: 'test/',
    });
    const references = Array.from({ length: 1707 }, (_, id) => ({
      id: id + 1,
      url: `https://documents.example.test/test/legacy-${id}.pdf`,
      size: 4,
    }));
    references.push({
      id: 9999,
      url: 'https://documents.example.test/test/',
      size: 0,
    });
    const progress = jest.fn();
    const inventory = await storage.inventory(references, undefined, progress);
    expect(send).toHaveBeenCalledTimes(16);
    expect(inventory.objects).toHaveLength(1707);
    expect(inventory.invalidReferences).toBe(1);
    expect(progress.mock.calls[0][0]).toMatchObject({
      event: 'inventory_progress',
      phase: 'current_objects',
      pages: 1,
    });
    expect(
      send.mock.calls.some(
        ([command]: any[]) =>
          command.input.Prefix === 'test/' && !command.input.Delimiter,
      ),
    ).toBe(false);
  });

  it('discovers old versions in folders absent from the current object list', async () => {
    const send = jest.fn(async (command: any) => {
      if (command.constructor.name !== 'ListObjectVersionsCommand') return {};
      if (command.input.Prefix === 'test/')
        return { CommonPrefixes: [{ Prefix: 'test/archive/' }] };
      if (command.input.Prefix === 'test/archive/')
        return {
          Versions: [
            {
              Key: 'test/archive/deleted.pdf',
              VersionId: 'old',
              IsLatest: false,
              ETag: 'old-etag',
              Size: 4,
            },
          ],
        };
      return {};
    });
    const storage = new S3DocumentStorage({ send } as unknown as S3Client, {
      ...config,
      prefix: 'test/',
    });
    const inventory = await storage.inventory([
      {
        id: 1,
        url: 'https://documents.example.test/test/archive/deleted.pdf',
        size: 4,
      },
    ]);
    expect(inventory.objects).toEqual([
      expect.objectContaining({
        key: 'test/archive/deleted.pdf',
        versionId: 'old',
        latest: false,
      }),
      expect.objectContaining({
        key: 'test/archive/deleted.pdf',
        latest: true,
      }),
    ]);
    expect(inventory.objects[1].versionId).toBeUndefined();
    expect(
      send.mock.calls.some(
        ([command]: any[]) =>
          command.input.Prefix === 'test/archive/deleted.pdf',
      ),
    ).toBe(false);
  });

  it('discovers nested documents and prioritizes known S3 objects over missing DB placeholders', async () => {
    const send = jest.fn(async (command: any) => {
      if (command.constructor.name !== 'ListObjectsV2Command') return {};
      if (command.input.Prefix === 'test/')
        return {
          CommonPrefixes: [
            { Prefix: 'test/z-archive/' },
            { Prefix: 'test//pmtiles/' },
          ],
        };
      if (command.input.Prefix === 'test/z-archive/')
        return {
          Contents: [
            { Key: 'test/z-archive/existing.docx', ETag: 'e', Size: 4 },
          ],
        };
      return {};
    });
    const storage = new S3DocumentStorage({ send } as unknown as S3Client, {
      ...config,
      prefix: 'test/',
    });
    const inventory = await storage.inventory([
      {
        id: 1,
        url: 'https://documents.example.test/test/a-missing.pdf',
        size: 4,
      },
    ]);
    expect(inventory.objects.map((object) => object.key)).toEqual([
      'test/z-archive/existing.docx',
      'test/a-missing.pdf',
    ]);
    expect(
      send.mock.calls.some(
        ([command]: any[]) => command.input.Prefix === 'test//pmtiles/',
      ),
    ).toBe(false);
  });

  it.each(['ListObjectsV2Command', 'ListObjectVersionsCommand'])(
    'rejects repeated pagination markers from %s',
    async (stalledCommand) => {
      const send = jest.fn(async (command: any) =>
        command.constructor.name === stalledCommand
          ? {
              IsTruncated: true,
              NextContinuationToken: 'same',
              NextKeyMarker: 'same',
              NextVersionIdMarker: 'same',
            }
          : {},
      );
      const storage = new S3DocumentStorage(
        { send } as unknown as S3Client,
        config,
      );
      await expect(storage.inventory([])).rejects.toMatchObject({
        name: 'InventoryPaginationStalled',
      });
    },
  );

  it('discovers orphan folders without recursively enumerating cartographic artifacts and reports inaccessible versions', async () => {
    const inputs: any[] = [];
    const send = jest.fn(async (command: any) => {
      inputs.push({ type: command.constructor.name, ...command.input });
      if (command.constructor.name === 'ListObjectVersionsCommand')
        throw Object.assign(new Error(), { name: 'AccessDenied' });
      if (command.input.Prefix === '')
        return {
          Contents: [{ Key: 'zones_geojson_2013.zip', Size: 100 }],
          CommonPrefixes: [
            { Prefix: 'geojson/' },
            { Prefix: 'historic-map-repairs/' },
            { Prefix: 'archive/' },
            { Prefix: 'test/' },
          ],
        };
      if (command.input.Prefix === 'archive/')
        return {
          Contents: [{ Key: 'archive/orphan.docx', Size: 4, ETag: 'e' }],
        };
      if (command.input.Prefix === '/arrete-cadre/')
        return { Contents: [{ Key: original.key, Size: 4, ETag: 'e1' }] };
      return {};
    });
    const storage = new S3DocumentStorage(
      { send } as unknown as S3Client,
      config,
    );
    const report = await storage.inventory([
      {
        id: 1,
        url: 'https://documents.example.test//arrete-cadre/file.pdf',
        size: 4,
      },
      { id: 2, url: 'http://169.254.169.254/f.pdf', size: 1 },
    ]);
    expect(report.objects.map((object) => object.key).sort()).toEqual(
      [original.key, 'archive/orphan.docx'].sort(),
    );
    expect(report.externalReferences).toBe(1);
    expect(report.versionCoverage).toBe('current-only-access-denied');
    expect(
      inputs.filter((input) =>
        ['geojson/', 'historic-map-repairs/', 'test/'].includes(input.Prefix),
      ),
    ).toHaveLength(0);
    expect(inputs.find((input) => input.Prefix === '')).toMatchObject({
      Delimiter: '/',
    });
  });

  function quarantineFixture(
    options: {
      changed?: boolean;
      public?: boolean;
      corruptCopy?: boolean;
      sourceVersionId?: string | null;
    } = {},
  ) {
    const send = jest.fn(async (command: any) => {
      if (command.constructor.name === 'HeadObjectCommand')
        return {
          ...metadata,
          VersionId:
            options.sourceVersionId === null
              ? undefined
              : (options.sourceVersionId ?? 'v1'),
          ...(command.input.Key.startsWith('_antivirus-quarantine/')
            ? { VersionId: 'q1' }
            : {}),
          ...(options.changed ? { ETag: 'changed' } : {}),
        };
      if (command.constructor.name === 'CopyObjectCommand')
        return { VersionId: 'q1' };
      if (command.constructor.name === 'GetObjectCommand')
        return {
          ...metadata,
          VersionId: 'q1',
          Body: Readable.from(options.corruptCopy ? Buffer.from('evil') : body),
        };
      return {};
    });
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(null, { status: options.public ? 200 : 403 }),
      );
    return {
      storage: new S3DocumentStorage({ send } as unknown as S3Client, config),
      send,
      fetchMock,
    };
  }

  it('privatizes the exact version, verifies a private identical copy, and never deletes original bytes', async () => {
    const { storage, send, fetchMock } = quarantineFixture();
    const result = await storage.quarantine(original, hash);
    expect(result.versionId).toBe('q1');
    const commands = send.mock.calls.map(([command]: any[]) => ({
      type: command.constructor.name,
      ...command.input,
    }));
    expect(
      commands.find((command) => command.type === 'PutObjectAclCommand'),
    ).toMatchObject({ Key: original.key, VersionId: 'v1', ACL: 'private' });
    expect(
      commands.find((command) => command.type === 'CopyObjectCommand'),
    ).toMatchObject({
      CopySource: 'documents//arrete-cadre/file.pdf?versionId=v1',
      ACL: 'private',
    });
    expect(
      commands.find((command) => command.type === 'CopyObjectCommand'),
    ).not.toHaveProperty('CopySourceIfMatch');
    expect(commands.some((command) => command.type.includes('Delete'))).toBe(
      false,
    );
    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          url === 'https://documents.example.test//arrete-cadre/file.pdf',
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.every(([, init]) => init.redirect === 'manual'),
    ).toBe(true);
  });
  it.each([null, 'null'])(
    'retains the ETag condition for mutable source version %s',
    async (sourceVersionId) => {
      const { storage, send } = quarantineFixture({ sourceVersionId });
      await storage.quarantine(
        { ...original, versionId: sourceVersionId ?? undefined },
        hash,
      );
      const copy = send.mock.calls.find(
        ([command]: any[]) => command.constructor.name === 'CopyObjectCommand',
      )[0] as any;
      expect(copy.input.CopySourceIfMatch).toBe('e1');
    },
  );
  it('stops without changing ACL when the source identity has changed', async () => {
    const { storage, send } = quarantineFixture({ changed: true });
    await expect(storage.quarantine(original, hash)).rejects.toThrow('changed');
    expect(
      send.mock.calls.some(
        ([command]: any[]) =>
          command.constructor.name === 'PutObjectAclCommand',
      ),
    ).toBe(false);
  });
  it('does not certify quarantine while the old anonymous URL remains readable', async () => {
    const { storage, send } = quarantineFixture({ public: true });
    await expect(storage.quarantine(original, hash)).rejects.toThrow(
      'access verification',
    );
    expect(
      send.mock.calls.some(
        ([command]: any[]) => command.constructor.name === 'CopyObjectCommand',
      ),
    ).toBe(false);
  });
  it('detects a corrupted copy and retains the restrictive original ACL', async () => {
    const { storage, send } = quarantineFixture({ corruptCopy: true });
    await expect(storage.quarantine(original, hash)).rejects.toThrow(
      'digest mismatch',
    );
    expect(
      send.mock.calls.filter(
        ([command]: any[]) =>
          command.constructor.name === 'PutObjectAclCommand',
      ),
    ).toHaveLength(1);
    expect(
      send.mock.calls.some(
        ([command]: any[]) => command.input.ACL === 'public-read',
      ),
    ).toBe(false);
  });

  it('does not treat an anonymous 404 as evidence that a quarantine copy still exists', async () => {
    const send = jest.fn(async () => {
      throw Object.assign(new Error(), { name: 'NotFound' });
    });
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 404 }));
    const storage = new S3DocumentStorage(
      { send } as unknown as S3Client,
      config,
    );
    await expect(
      storage.verifyQuarantine({
        identity: 'i',
        object: original,
        status: 'infected',
        result: { status: 'infected', bytes: 4, sha256: hash },
        quarantineKey: '_antivirus-quarantine/gone',
        quarantineVersionId: 'q1',
      }),
    ).rejects.toMatchObject({ name: 'NotFound' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
