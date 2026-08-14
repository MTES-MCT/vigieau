import { FichierService } from './fichier.service';

describe('FichierService.createImmutable', () => {
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
