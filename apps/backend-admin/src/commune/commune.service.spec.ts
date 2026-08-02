import { of } from 'rxjs';
import { CommuneService } from './commune.service';

const DEPARTEMENT = { id: 65, code: '65', nom: 'Hautes-Pyrenees' };
const GEOMETRY = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ],
  ],
};

function createHarness(
  apiCommune: Record<string, unknown> | Record<string, unknown>[],
  existing?: any,
) {
  const communeRepository = {
    count: jest.fn().mockResolvedValue(1),
    findOne: jest.fn().mockResolvedValue(existing ?? null),
    query: jest.fn().mockResolvedValue([{ valid: true, matches: false }]),
    save: jest.fn(async (commune) => commune),
  };
  const httpService = {
    get: jest
      .fn()
      .mockReturnValue(
        of({ data: Array.isArray(apiCommune) ? apiCommune : [apiCommune] }),
      ),
  };
  const departementService = {
    findAllLight: jest.fn().mockResolvedValue([DEPARTEMENT]),
  };
  const configService = {
    get: jest.fn().mockReturnValue('https://geo.api.gouv.fr'),
  };

  return {
    service: new CommuneService(
      httpService as any,
      communeRepository as any,
      departementService as any,
      configService as any,
    ),
    communeRepository,
    httpService,
  };
}

describe('CommuneService.updateCommuneRef', () => {
  const apiCommune = {
    code: '65440',
    codeDepartement: '65',
    nom: 'Tarbes',
    population: 43287,
    siren: '216504407',
    contour: GEOMETRY,
  };

  it('does not save an unchanged commune', async () => {
    const harness = createHarness(apiCommune, {
      id: 65440,
      ...apiCommune,
      geom: JSON.parse(JSON.stringify(GEOMETRY)),
      departement: DEPARTEMENT,
    });

    await harness.service.updateCommuneRef();

    expect(harness.communeRepository.save).not.toHaveBeenCalled();
    expect(harness.communeRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ geom: true }),
        relations: ['departement'],
        where: { code: '65440' },
      }),
    );
  });

  it('saves a commune when its geometry changed', async () => {
    const harness = createHarness(apiCommune, {
      id: 65440,
      code: apiCommune.code,
      nom: apiCommune.nom,
      population: apiCommune.population,
      siren: apiCommune.siren,
      geom: { ...GEOMETRY, coordinates: [] },
      departement: DEPARTEMENT,
    });

    await harness.service.updateCommuneRef();

    expect(harness.communeRepository.save).toHaveBeenCalledTimes(1);
    expect(harness.communeRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 65440,
        geom: GEOMETRY,
      }),
    );
  });

  it('does not save topologically equal PostGIS geometry', async () => {
    const harness = createHarness(apiCommune, {
      id: 65440,
      code: apiCommune.code,
      nom: apiCommune.nom,
      population: apiCommune.population,
      siren: apiCommune.siren,
      geom: {
        ...GEOMETRY,
        coordinates: [[...GEOMETRY.coordinates[0]].reverse()],
      },
      departement: DEPARTEMENT,
    });
    harness.communeRepository.query.mockResolvedValue([
      { valid: true, matches: true },
    ]);

    await harness.service.updateCommuneRef();

    expect(harness.communeRepository.query).toHaveBeenCalledWith(
      expect.stringContaining('ST_Equals'),
      [65440, JSON.stringify(GEOMETRY)],
    );
    expect(harness.communeRepository.save).not.toHaveBeenCalled();
  });

  it('saves a commune when a scalar or department changed', async () => {
    const harness = createHarness(apiCommune, {
      id: 65440,
      code: apiCommune.code,
      nom: 'Ancien nom',
      population: apiCommune.population,
      siren: apiCommune.siren,
      geom: GEOMETRY,
      departement: { id: 64 },
    });

    await harness.service.updateCommuneRef();

    expect(harness.communeRepository.save).toHaveBeenCalledTimes(1);
    expect(harness.communeRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        nom: 'Tarbes',
        departement: DEPARTEMENT,
      }),
    );
  });

  it('inserts a commune that does not exist yet', async () => {
    const harness = createHarness(apiCommune);

    await harness.service.updateCommuneRef();

    expect(harness.communeRepository.save).toHaveBeenCalledTimes(1);
    expect(harness.communeRepository.query).toHaveBeenCalledWith(
      expect.stringContaining('ST_IsValid'),
      [JSON.stringify(GEOMETRY)],
    );
    expect(harness.communeRepository.save).toHaveBeenCalledWith({
      code: '65440',
      nom: 'Tarbes',
      population: 43287,
      siren: '216504407',
      geom: GEOMETRY,
      departement: DEPARTEMENT,
    });
  });

  it('rejects an invalid geometry before inserting a commune', async () => {
    const harness = createHarness(apiCommune);
    harness.communeRepository.query.mockResolvedValue([{ valid: false }]);

    await expect(harness.service.updateCommuneRef()).rejects.toThrow(
      'Invalid commune geometry for 65440',
    );
    expect(harness.communeRepository.save).not.toHaveBeenCalled();
  });

  it('rejects an invalid geometry before filling a missing geometry', async () => {
    const harness = createHarness(apiCommune, {
      id: 65440,
      code: apiCommune.code,
      nom: apiCommune.nom,
      population: apiCommune.population,
      siren: apiCommune.siren,
      geom: null,
      departement: DEPARTEMENT,
    });
    harness.communeRepository.query.mockResolvedValue([{ valid: false }]);

    await expect(harness.service.updateCommuneRef()).rejects.toThrow(
      'Invalid commune geometry for 65440',
    );
    expect(harness.communeRepository.query).toHaveBeenCalledWith(
      expect.stringContaining('ST_IsValid'),
      [JSON.stringify(GEOMETRY)],
    );
    expect(harness.communeRepository.save).not.toHaveBeenCalled();
  });

  it('keeps explicit nullable scalar values without repeated writes', async () => {
    const communeWithNulls = {
      ...apiCommune,
      population: null,
      siren: null,
    };
    const harness = createHarness(communeWithNulls, {
      id: 65440,
      code: apiCommune.code,
      nom: apiCommune.nom,
      population: null,
      siren: null,
      geom: GEOMETRY,
      departement: DEPARTEMENT,
    });

    await harness.service.updateCommuneRef();

    expect(harness.communeRepository.save).not.toHaveBeenCalled();
  });

  it('rejects a null geometry before writing the department', async () => {
    const harness = createHarness(
      { ...apiCommune, contour: null },
      {
        id: 65440,
        code: apiCommune.code,
        nom: apiCommune.nom,
        population: apiCommune.population,
        siren: apiCommune.siren,
        geom: GEOMETRY,
        departement: DEPARTEMENT,
      },
    );

    await expect(harness.service.updateCommuneRef()).rejects.toThrow(
      'Incomplete commune reference payload for department 65',
    );
    expect(harness.communeRepository.findOne).not.toHaveBeenCalled();
    expect(harness.communeRepository.save).not.toHaveBeenCalled();
  });

  it('rejects an incomplete API response before writing the department', async () => {
    const { contour: _contour, ...incompleteCommune } = apiCommune;
    void _contour;
    const harness = createHarness(incompleteCommune, {
      id: 65440,
      code: apiCommune.code,
      nom: apiCommune.nom,
      population: apiCommune.population,
      siren: apiCommune.siren,
      geom: GEOMETRY,
      departement: DEPARTEMENT,
    });

    await expect(harness.service.updateCommuneRef()).rejects.toThrow(
      'Incomplete commune reference payload for department 65',
    );
    expect(harness.communeRepository.findOne).not.toHaveBeenCalled();
    expect(harness.communeRepository.save).not.toHaveBeenCalled();
  });

  it('rejects communes returned for another department', async () => {
    const harness = createHarness({
      ...apiCommune,
      codeDepartement: '64',
    });

    await expect(harness.service.updateCommuneRef()).rejects.toThrow(
      'Incomplete commune reference payload for department 65',
    );
    expect(harness.communeRepository.findOne).not.toHaveBeenCalled();
    expect(harness.communeRepository.save).not.toHaveBeenCalled();
  });

  it('rejects an empty department response', async () => {
    const harness = createHarness([]);

    await expect(harness.service.updateCommuneRef()).rejects.toThrow(
      'Incomplete commune reference payload for department 65',
    );
    expect(harness.communeRepository.findOne).not.toHaveBeenCalled();
    expect(harness.communeRepository.save).not.toHaveBeenCalled();
  });

  it('rejects duplicate commune codes', async () => {
    const harness = createHarness([apiCommune, { ...apiCommune }]);

    await expect(harness.service.updateCommuneRef()).rejects.toThrow(
      'Incomplete commune reference payload for department 65',
    );
    expect(harness.communeRepository.findOne).not.toHaveBeenCalled();
    expect(harness.communeRepository.save).not.toHaveBeenCalled();
  });

  it('rejects a response truncated below the known department size', async () => {
    const harness = createHarness(apiCommune);
    harness.communeRepository.count.mockResolvedValue(20);

    await expect(harness.service.updateCommuneRef()).rejects.toThrow(
      'Incomplete commune reference payload for department 65',
    );
    expect(harness.communeRepository.findOne).not.toHaveBeenCalled();
    expect(harness.communeRepository.save).not.toHaveBeenCalled();
  });

  it('cross-checks a complete bootstrap response before inserting', async () => {
    const harness = createHarness(apiCommune);
    harness.communeRepository.count.mockResolvedValue(0);
    harness.httpService.get
      .mockReturnValueOnce(of({ data: [apiCommune] }))
      .mockReturnValueOnce(
        of({
          data: [
            {
              code: apiCommune.code,
              codeDepartement: apiCommune.codeDepartement,
            },
          ],
        }),
      );

    await harness.service.updateCommuneRef();

    expect(harness.httpService.get).toHaveBeenCalledTimes(2);
    expect(harness.communeRepository.save).toHaveBeenCalledTimes(1);
  });

  it('rejects a truncated bootstrap response before inserting', async () => {
    const harness = createHarness(apiCommune);
    harness.communeRepository.count.mockResolvedValue(0);
    harness.httpService.get
      .mockReturnValueOnce(of({ data: [apiCommune] }))
      .mockReturnValueOnce(
        of({
          data: [
            {
              code: apiCommune.code,
              codeDepartement: apiCommune.codeDepartement,
            },
            { code: '65001', codeDepartement: '65' },
          ],
        }),
      );

    await expect(harness.service.updateCommuneRef()).rejects.toThrow(
      'Incomplete commune reference payload for department 65',
    );
    expect(harness.communeRepository.findOne).not.toHaveBeenCalled();
    expect(harness.communeRepository.save).not.toHaveBeenCalled();
  });
});
