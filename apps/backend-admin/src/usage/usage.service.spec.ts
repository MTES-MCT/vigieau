import { UsageService } from './usage.service';

function createHarness(managerRepository?: Record<string, jest.Mock>) {
  const query = jest.fn(async (_sql: string, parameters: [number[], number]) =>
    parameters[0].map((id) => ({ id })),
  );
  const repository = {
    delete: jest.fn().mockResolvedValue(undefined),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn(async (values) => values),
    manager: { query },
  };
  const manager = managerRepository
    ? {
        getRepository: jest.fn().mockReturnValue(managerRepository),
        query,
      }
    : undefined;

  return {
    service: new UsageService(repository as any),
    repository,
    manager,
    query,
  };
}

describe('UsageService.updateAllByRestriction', () => {
  it('verrouille les usages existants appartenant à la restriction avant mutation', async () => {
    const { service, repository, query } = createHarness();
    const existingUsage = { id: 12, nom: 'Existing' };
    const newUsage = { nom: 'New' };

    await service.updateAllByRestriction({
      id: 42,
      usages: [existingUsage, newUsage],
    } as any);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), [
      [12],
      42,
    ]);
    expect(repository.delete).toHaveBeenCalled();
    expect(repository.save).toHaveBeenCalledWith([
      { ...existingUsage, restriction: { id: 42 } },
      { ...newUsage, restriction: { id: 42 } },
    ]);
  });

  it('rejette un usage appartenant à une autre restriction sans rien modifier', async () => {
    const { service, repository, query } = createHarness();
    query.mockResolvedValueOnce([]);
    const usage = { id: 12, nom: 'Foreign' };

    await expect(
      service.updateAllByRestriction({ id: 42, usages: [usage] } as any),
    ).rejects.toThrow(
      `Un usage à modifier n'appartient pas à cette restriction.`,
    );

    expect(repository.delete).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
    expect(usage).not.toHaveProperty('restriction');
  });

  it('rejette des identifiants dupliqués sans requête ni mutation', async () => {
    const { service, repository, query } = createHarness();

    await expect(
      service.updateAllByRestriction({
        id: 42,
        usages: [
          { id: 12, nom: 'First' },
          { id: 12, nom: 'Duplicate' },
        ],
      } as any),
    ).rejects.toThrow(`Les identifiants des usages à modifier sont invalides.`);

    expect(query).not.toHaveBeenCalled();
    expect(repository.delete).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('rejette un identifiant invalide sans requête ni mutation', async () => {
    const { service, repository, query } = createHarness();

    await expect(
      service.updateAllByRestriction({
        id: 42,
        usages: [{ id: -1, nom: 'Invalid' }],
      } as any),
    ).rejects.toThrow(`Les identifiants des usages à modifier sont invalides.`);

    expect(query).not.toHaveBeenCalled();
    expect(repository.delete).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });
});

describe('UsageService.updateAllByArreteCadre', () => {
  it('keeps existing ids and ignores new usages without an id in the delete filter', async () => {
    const { service, repository } = createHarness();
    const existingUsage = { id: 12, nom: 'Existing' };
    const newUsage = { nom: 'New' };

    await service.updateAllByArreteCadre({
      id: 42,
      usages: [existingUsage, newUsage],
    } as any);

    const deleteCriteria = repository.delete.mock.calls[0][0];
    expect(deleteCriteria.arreteCadre).toEqual({ id: 42 });
    expect(deleteCriteria.id._type).toBe('not');
    expect(deleteCriteria.id._value._type).toBe('in');
    expect(deleteCriteria.id._value._value).toEqual([12]);
    expect(repository.save).toHaveBeenCalledWith([
      { ...existingUsage, arreteCadre: { id: 42 } },
      { ...newUsage, arreteCadre: { id: 42 } },
    ]);
    expect(repository.manager.query).toHaveBeenCalledWith(
      expect.stringContaining('usage."arreteCadreId" = $2'),
      [[12], 42],
    );
  });

  it('deletes all old usages without creating Not(In([])) when every usage is new', async () => {
    const managerRepository = {
      delete: jest.fn().mockResolvedValue(undefined),
      save: jest.fn(async (values) => values),
    };
    const { service, repository, manager } = createHarness(managerRepository);

    await service.updateAllByArreteCadre(
      {
        id: 42,
        usages: [{ nom: 'New' }],
      } as any,
      manager as any,
    );

    expect(manager.getRepository).toHaveBeenCalled();
    expect(managerRepository.delete).toHaveBeenCalledWith({
      arreteCadre: { id: 42 },
    });
    expect(managerRepository.save).toHaveBeenCalledWith([
      { nom: 'New', arreteCadre: { id: 42 } },
    ]);
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it('rejette un usage appartenant à un autre arrêté cadre sans rien modifier', async () => {
    const { service, repository, query } = createHarness();
    query.mockResolvedValueOnce([]);
    const usage = { id: 12, nom: 'Foreign' };

    await expect(
      service.updateAllByArreteCadre({ id: 42, usages: [usage] } as any),
    ).rejects.toThrow(
      `Un usage à modifier n'appartient pas à cet arrêté cadre.`,
    );

    expect(repository.delete).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
    expect(usage).not.toHaveProperty('arreteCadre');
  });

  it('rejette des identifiants dupliqués avant toute requête ou mutation', async () => {
    const { service, repository, query } = createHarness();

    await expect(
      service.updateAllByArreteCadre({
        id: 42,
        usages: [
          { id: 12, nom: 'First' },
          { id: 12, nom: 'Duplicate' },
        ],
      } as any),
    ).rejects.toThrow(`Les identifiants des usages à modifier sont invalides.`);

    expect(query).not.toHaveBeenCalled();
    expect(repository.delete).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });
});
