import { ArreteCadreZoneAlerteCommunesService } from './arrete_cadre_zone_alerte_communes.service';

function createRepository(existingAssociations: any[] = []) {
  return {
    find: jest.fn().mockResolvedValue(existingAssociations),
    delete: jest.fn().mockResolvedValue(undefined),
    save: jest.fn(async (values) => values),
  };
}

describe('ArreteCadreZoneAlerteCommunesService.updateAllByArreteCadre', () => {
  it('matches existing associations by zone id, deletes stale rows and deduplicates input', async () => {
    const communes = [{ id: 65001 }];
    const replacementCommunes = [{ id: 65002 }];
    const repository = createRepository([
      { id: 101, zoneAlerte: { id: 10 } },
      { id: 202, zoneAlerte: { id: 20 } },
    ]);
    const service = new ArreteCadreZoneAlerteCommunesService(repository as any);

    await service.updateAllByArreteCadre(42, {
      zonesAlerte: [
        { id: 10, communes },
        { id: 10, communes: replacementCommunes },
      ],
    } as any);

    expect(repository.find).toHaveBeenCalledWith({
      relations: { zoneAlerte: true },
      where: { arreteCadre: { id: 42 } },
    });
    expect(repository.delete.mock.calls[0][0].id._value).toEqual([202]);
    expect(repository.save).toHaveBeenCalledWith([
      {
        id: 101,
        arreteCadre: { id: 42 },
        zoneAlerte: { id: 10 },
        communes: replacementCommunes,
      },
    ]);
  });

  it('uses the transaction manager repository and removes all associations when no zone has communes', async () => {
    const baseRepository = createRepository();
    const managerRepository = createRepository([
      { id: 101, zoneAlerte: { id: 10 } },
      { id: 202, zoneAlerte: { id: 20 } },
    ]);
    const manager = {
      getRepository: jest.fn().mockReturnValue(managerRepository),
    };
    const service = new ArreteCadreZoneAlerteCommunesService(
      baseRepository as any,
    );

    const result = await service.updateAllByArreteCadre(
      42,
      {
        zonesAlerte: [{ id: 10, communes: [] }],
      } as any,
      manager as any,
    );

    expect(manager.getRepository).toHaveBeenCalled();
    expect(managerRepository.delete.mock.calls[0][0].id._value).toEqual([
      101, 202,
    ]);
    expect(managerRepository.save).not.toHaveBeenCalled();
    expect(baseRepository.find).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});
