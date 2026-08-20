import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { S3Service } from './s3.service';

jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn(),
}));

describe('S3Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createHarness = () => {
    const values = {
      NODE_ENV: 'local',
      S3_BUCKET: 'vigieau-bucket',
      S3_PREFIX: 'prod/',
      S3_VHOST: 'https://objects.example.test/',
    };
    const service = new S3Service({
      get: jest.fn((key: string) => values[key]),
    } as any);
    const send = jest.fn().mockResolvedValue({ ContentLength: 42 });
    (service as any).client = { send };
    return { send, service };
  };

  it('builds a normalized public URL from the configured prefix', () => {
    const values = {
      S3_VHOST: 'https://objects.example.test/',
      S3_PREFIX: 'preprod/',
      NODE_ENV: 'test',
    };
    const service = new S3Service({
      get: jest.fn((key: keyof typeof values) => values[key]),
    } as any);

    expect(
      service.getPublicFileUrl('zones_arretes_en_vigueur.pmtiles', 'pmtiles/'),
    ).toBe(
      'https://objects.example.test/preprod/pmtiles/zones_arretes_en_vigueur.pmtiles',
    );
  });

  it('rejects a missing public S3 base URL', () => {
    const service = new S3Service({ get: jest.fn() } as any);

    expect(() => service.getPublicFileUrl('zones.pmtiles')).toThrow(
      'S3_VHOST is required',
    );
  });

  it('forwards the abort signal to S3 copies', async () => {
    const harness = createHarness();
    const abortSignal = AbortSignal.timeout(1_000);

    await harness.service.copyFile(
      'source.pmtiles',
      'stable.pmtiles',
      'pmtiles/',
      { abortSignal },
    );

    expect(harness.send).toHaveBeenCalledWith(expect.any(Object), {
      abortSignal,
    });
  });

  it('copies stable aliases with explicit cache and content metadata', async () => {
    const harness = createHarness();

    await harness.service.copyFile(
      'immutable.pmtiles',
      'current.pmtiles',
      'pmtiles/',
      {
        cacheControl: 'public, max-age=0, must-revalidate',
        contentType: 'application/vnd.pmtiles',
      },
    );

    const [command] = harness.send.mock.calls[0];
    expect(command).toBeInstanceOf(CopyObjectCommand);
    expect(command.input).toEqual(
      expect.objectContaining({
        Bucket: 'vigieau-bucket',
        Key: 'prod/pmtiles/current.pmtiles',
        CopySource: '/vigieau-bucket/prod/pmtiles/immutable.pmtiles',
        CacheControl: 'public, max-age=0, must-revalidate',
        ContentType: 'application/vnd.pmtiles',
        MetadataDirective: 'REPLACE',
      }),
    );
  });

  it('heads the exact prefixed key used by validation', async () => {
    const harness = createHarness();
    const abortSignal = AbortSignal.timeout(1_000);

    await expect(
      harness.service.headFile('current.geojson', 'geojson/', { abortSignal }),
    ).resolves.toEqual({ ContentLength: 42 });

    const [command] = harness.send.mock.calls[0];
    expect(command).toBeInstanceOf(HeadObjectCommand);
    expect(command.input).toEqual({
      Bucket: 'vigieau-bucket',
      Key: 'prod/geojson/current.geojson',
    });
    expect(harness.send).toHaveBeenCalledWith(command, { abortSignal });
  });

  it('downloads the exact prefixed object as a buffer', async () => {
    const harness = createHarness();
    const abortSignal = AbortSignal.timeout(1_000);
    harness.send.mockResolvedValueOnce({
      Body: {
        transformToByteArray: jest
          .fn()
          .mockResolvedValue(Uint8Array.from([1, 2, 3])),
      },
    });

    await expect(
      harness.service.downloadFile('run/segment.geojson', 'historic/', {
        abortSignal,
      }),
    ).resolves.toEqual(Buffer.from([1, 2, 3]));

    const [command] = harness.send.mock.calls[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({
      Bucket: 'vigieau-bucket',
      Key: 'prod/historic/run/segment.geojson',
    });
    expect(harness.send).toHaveBeenCalledWith(command, { abortSignal });
  });

  it('rejects an S3 object without a response body', async () => {
    const harness = createHarness();
    harness.send.mockResolvedValueOnce({});

    await expect(harness.service.downloadFile('missing')).rejects.toThrow(
      'has no body',
    );
  });

  it.each([
    { acl: undefined, expectedAcl: 'public-read' },
    { acl: 'private' as const, expectedAcl: 'private' },
  ])('uploads with $expectedAcl ACL', async ({ acl, expectedAcl }) => {
    const harness = createHarness();
    const abort = jest.fn().mockResolvedValue(undefined);
    const done = jest.fn().mockResolvedValue({});
    (Upload as unknown as jest.Mock).mockImplementationOnce(() => ({
      abort,
      done,
    }));

    await harness.service.uploadFile(
      {
        originalname: 'artifact.geojson',
        mimetype: 'application/geo+json',
        buffer: Buffer.from('{}'),
      } as Express.Multer.File,
      'historic/',
      acl ? { acl } : {},
    );

    expect(Upload).toHaveBeenCalledWith({
      client: (harness.service as any).client,
      params: expect.objectContaining({
        Bucket: 'vigieau-bucket',
        Key: 'prod/historic/artifact.geojson',
        ACL: expectedAcl,
      }),
    });
  });

  it('aborts an in-flight multipart upload when its deadline expires', async () => {
    const harness = createHarness();
    const abort = jest.fn().mockResolvedValue(undefined);
    let rejectUpload: (error: Error) => void;
    const done = jest.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectUpload = reject;
        }),
    );
    (Upload as unknown as jest.Mock).mockImplementationOnce(() => ({
      abort,
      done,
    }));
    const controller = new AbortController();

    const upload = harness.service.uploadFile(
      {
        originalname: 'immutable.pmtiles',
        mimetype: 'application/vnd.pmtiles',
        buffer: Buffer.from('PMTiles'),
      } as Express.Multer.File,
      'pmtiles/',
      { abortSignal: controller.signal },
    );
    const rejection = expect(upload).rejects.toThrow('upload aborted');

    controller.abort(new Error('deadline exceeded'));
    expect(abort).toHaveBeenCalledTimes(1);
    rejectUpload!(new Error('upload aborted'));

    await rejection;
  });
});
