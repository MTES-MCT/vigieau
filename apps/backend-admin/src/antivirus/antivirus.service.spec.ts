import { createHash } from 'node:crypto';
import { AntivirusService } from './antivirus.service';
import * as core from './antivirus.core';

function service(
  values: Record<string, string> = { ANTIVIRUS_ENABLED: 'true' },
) {
  return new AntivirusService({ get: (key) => values[key] } as any);
}
function file() {
  return {
    buffer: Buffer.from('%PDF-1.7\n'),
    originalname: 'document.pdf',
  } as Express.Multer.File;
}
function clean(document: Express.Multer.File): core.ScanResult {
  return {
    status: 'clean',
    bytes: document.buffer.length,
    sha256: createHash('sha256').update(document.buffer).digest('hex'),
  };
}

describe('AntivirusService upload policy', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    { NODE_ENV: 'prod', ANTIVIRUS_ENABLED: 'false' },
    { NODE_ENV: 'test', SENTRY_ENV: 'preprod', ANTIVIRUS_ENABLED: 'false' },
    { NODE_ENV: 'production' },
    { NODE_ENV: 'test' },
  ])(
    'fails closed for a missing or forbidden disable flag: %j',
    async (values) => {
      await expect(service(values).scanOrThrow(file())).rejects.toMatchObject({
        status: 503,
      });
    },
  );

  it('only permits an explicitly disabled local/test scanner', async () => {
    const scan = jest.spyOn(core, 'scanDocumentStream');
    await service({ NODE_ENV: 'test', ANTIVIRUS_ENABLED: 'false' }).scanOrThrow(
      file(),
    );
    expect(scan).not.toHaveBeenCalled();
  });

  it.each([
    ['infected', 422],
    ['unscannable', 422],
    ['error', 503],
  ] as const)('refuses %s with HTTP %s', async (status, expected) => {
    jest
      .spyOn(core, 'scanDocumentStream')
      .mockResolvedValue({ status, bytes: 1 });
    await expect(service().scanOrThrow(file())).rejects.toMatchObject({
      status: expected,
    });
  });

  it('bounds concurrency and allows retry when the active scan finishes', async () => {
    const document = file();
    let resolve: (result: core.ScanResult) => void;
    const scan = jest.spyOn(core, 'scanDocumentStream').mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const antivirus = service();
    const first = antivirus.scanOrThrow(document);
    await expect(antivirus.scanOrThrow(file())).rejects.toMatchObject({
      status: 503,
    });
    expect(scan).toHaveBeenCalledTimes(1);
    resolve(clean(document));
    await first;
    scan.mockResolvedValue(clean(document));
    await antivirus.scanOrThrow(file());
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a verdict after signatures may have changed', async () => {
    const document = file();
    const scan = jest
      .spyOn(core, 'scanDocumentStream')
      .mockResolvedValue(clean(document));
    const antivirus = service();
    await antivirus.scanOrThrow(document);
    await antivirus.scanOrThrow(document);
    expect(scan).toHaveBeenCalledTimes(2);
    document.buffer[0] = 0;
    scan.mockResolvedValue({ status: 'infected', bytes: 1 });
    await expect(antivirus.scanOrThrow(document)).rejects.toMatchObject({
      status: 422,
    });
    expect(scan).toHaveBeenCalledTimes(3);
  });
});
