import { FichierService } from './fichier.service';

describe('FichierService.createImmutable', () => {
  it('never uploads or saves a rejected document', async () => {
    const repository = { save: jest.fn() };
    const s3 = { uploadFile: jest.fn() };
    const antivirus = {
      scanOrThrow: jest.fn().mockRejectedValue(new Error('infected')),
    };
    const service = new FichierService(
      repository as any,
      s3 as any,
      {} as any,
      {} as any,
      antivirus as any,
    );
    await expect(
      service.createImmutable({} as any, 'arrete-cadre/1/'),
    ).rejects.toThrow('infected');
    expect(s3.uploadFile).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('also scans legacy Propluvia transfers before changing their object or reference', async () => {
    const repository = {
      find: jest
        .fn()
        .mockResolvedValue([
          { id: 1, url: 'https://old/pdf.pdf', nom: 'pdf.pdf' },
        ]),
      update: jest.fn(),
    };
    const s3 = { uploadFile: jest.fn() };
    const antivirus = {
      scanOrThrow: jest.fn().mockRejectedValue(new Error('infected')),
    };
    const http = {
      axiosRef: jest.fn().mockResolvedValue({ data: Buffer.from('document') }),
    };
    const service = new FichierService(
      repository as any,
      s3 as any,
      http as any,
      { get: jest.fn() } as any,
      antivirus as any,
    );
    const log = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      await service.migrateFiles();
      expect(antivirus.scanOrThrow).toHaveBeenCalled();
      expect(s3.uploadFile).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('uses a unique object prefix while preserving the displayed file name', async () => {
    const repository = {
      save: jest.fn(async (value) => ({ id: 20, ...value })),
    };
    const s3Service = {
      uploadFile: jest.fn().mockResolvedValue({
        Location:
          'https://objects.example.test/arrete-restriction/1/unique/arrete.pdf',
      }),
    };
    const service = new FichierService(
      repository as any,
      s3Service as any,
      {} as any,
      {} as any,
      { scanOrThrow: jest.fn().mockResolvedValue(undefined) } as any,
    );
    const file = {
      originalname: 'arrete.pdf',
      size: 123,
    } as Express.Multer.File;

    const created = await service.createImmutable(
      file,
      'arrete-restriction/1/',
    );

    expect(s3Service.uploadFile).toHaveBeenCalledWith(
      file,
      expect.stringMatching(/^arrete-restriction\/1\/[0-9a-f-]{36}\/$/),
    );
    expect(repository.save).toHaveBeenCalledWith({
      nom: 'arrete.pdf',
      size: 123,
      url: 'https://objects.example.test/arrete-restriction/1/unique/arrete.pdf',
    });
    expect(created.nom).toBe('arrete.pdf');
  });
});
