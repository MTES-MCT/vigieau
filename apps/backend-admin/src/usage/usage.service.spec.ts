import { UsageService } from './usage.service';

function createHarness(managerRepository?: Record<string, jest.Mock>) {
  const repository = {
    delete: jest.fn().mockResolvedValue(undefined),
    save: jest.fn(async (values) => values),
  };
  const manager = managerRepository
    ? {
        getRepository: jest.fn().mockReturnValue(managerRepository),
      }
    : undefined;

  return {
    service: new UsageService(repository as any),
    repository,
    manager,
  };
}

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
});
