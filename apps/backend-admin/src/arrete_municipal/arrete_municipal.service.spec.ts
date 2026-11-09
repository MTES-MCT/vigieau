import { UnprocessableEntityException } from '@nestjs/common';
import { ArreteMunicipalService } from './arrete_municipal.service';

function harness() {
  const current = {
    id: 1,
    statut: 'publie',
    fichier: { id: 10 },
    communes: [{ code: '01001', nom: 'Commune' }],
    dateDebut: '2026-01-01',
  };
  const transactionRepository = {
    save: jest.fn(async (data) => ({ ...current, ...data })),
    findOne: jest.fn().mockResolvedValue(current),
  };
  const repository = {
    save: jest.fn(),
    update: jest.fn(),
    manager: {
      transaction: jest.fn(async (_isolation, callback) =>
        callback({ getRepository: () => transactionRepository }),
      ),
    },
  };
  const fichiers = {
    scanOrThrow: jest.fn().mockResolvedValue(undefined),
    createImmutable: jest
      .fn()
      .mockResolvedValue({ id: 20, url: 'https://objects.example/new.pdf' }),
    deleteById: jest.fn().mockResolvedValue(undefined),
  };
  const mail = { sendEmailsByDepartement: jest.fn() };
  const service = new ArreteMunicipalService(
    repository as any,
    fichiers as any,
    {} as any,
    mail as any,
    { get: jest.fn() } as any,
  );
  jest.spyOn(service, 'canCreateArreteMunicipal').mockResolvedValue(true);
  jest.spyOn(service, 'canEditArreteMunicipal').mockResolvedValue(true);
  jest.spyOn(service, 'findOne').mockResolvedValue(current as any);
  const dto = {
    dateDebut: '2026-01-01',
    dateFin: null,
    communes: current.communes,
  } as any;
  const pdf = { originalname: 'document.pdf' } as any;
  return {
    service,
    repository,
    transactionRepository,
    fichiers,
    mail,
    dto,
    pdf,
  };
}

describe('municipal PDF publication atomicity', () => {
  it('does not create a row or send emails when antivirus rejects the PDF', async () => {
    const h = harness();
    h.fichiers.createImmutable.mockRejectedValue(
      new UnprocessableEntityException(),
    );
    await expect(h.service.create(h.dto, h.pdf)).rejects.toMatchObject({
      status: 422,
    });
    expect(h.repository.manager.transaction).not.toHaveBeenCalled();
    expect(h.mail.sendEmailsByDepartement).not.toHaveBeenCalled();
  });

  it('does not start a transaction when the object upload fails', async () => {
    const h = harness();
    h.fichiers.createImmutable.mockRejectedValue(new Error('S3 unavailable'));
    await expect(h.service.create(h.dto, h.pdf)).rejects.toThrow(
      'S3 unavailable',
    );
    expect(h.repository.manager.transaction).not.toHaveBeenCalled();
    expect(h.transactionRepository.save).not.toHaveBeenCalled();
    expect(h.mail.sendEmailsByDepartement).not.toHaveBeenCalled();
  });

  it('keeps the current row and PDF if a replacement is rejected', async () => {
    const h = harness();
    h.fichiers.createImmutable.mockRejectedValue(
      new UnprocessableEntityException(),
    );
    await expect(h.service.update(1, h.dto, h.pdf)).rejects.toMatchObject({
      status: 422,
    });
    expect(h.repository.manager.transaction).not.toHaveBeenCalled();
    expect(h.repository.save).not.toHaveBeenCalled();
    expect(h.repository.update).not.toHaveBeenCalled();
    expect(h.fichiers.deleteById).not.toHaveBeenCalled();
  });

  it('atomically swaps the reference while retaining the previous published PDF', async () => {
    const h = harness();
    await h.service.update(1, h.dto, h.pdf);
    expect(h.transactionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, fichier: { id: 20 } }),
    );
    expect(h.fichiers.deleteById).not.toHaveBeenCalled();
  });

  it('cleans only the new unreferenced PDF if the transaction fails', async () => {
    const h = harness();
    h.transactionRepository.save.mockRejectedValue(
      new Error('transaction failed'),
    );
    await expect(h.service.update(1, h.dto, h.pdf)).rejects.toThrow(
      'transaction failed',
    );
    expect(h.fichiers.deleteById).toHaveBeenCalledTimes(1);
    expect(h.fichiers.deleteById).toHaveBeenCalledWith(20);
  });
});
