import { S3Service } from './s3.service';

describe('S3Service', () => {
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
    const service = new S3Service({
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          S3_BUCKET: 'vigieau',
          S3_PREFIX: 'preprod/',
          NODE_ENV: 'test',
        };
        return values[key];
      }),
    } as any);
    const send = jest.fn().mockResolvedValue({});
    (service as any).client = { send };
    const abortSignal = AbortSignal.timeout(1_000);

    await service.copyFile('source.pmtiles', 'stable.pmtiles', 'pmtiles/', {
      abortSignal,
    });

    expect(send).toHaveBeenCalledWith(expect.any(Object), { abortSignal });
  });
});
