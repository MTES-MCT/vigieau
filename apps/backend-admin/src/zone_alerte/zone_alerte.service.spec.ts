import { of } from 'rxjs';
import { ZoneAlerteService } from './zone_alerte.service';

describe('ZoneAlerteService', () => {
  const createService = (overrides?: {
    zoneAlerteRepository?: any;
    httpService?: any;
  }) => {
    const zoneAlerteRepository = overrides?.zoneAlerteRepository ?? {
      findOne: jest.fn(),
      save: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(undefined),
    };

    return {
      zoneAlerteRepository,
      service: new ZoneAlerteService(
        zoneAlerteRepository,
        {
          get: jest.fn().mockReturnValue('https://services.sandre.test'),
        } as any,
        overrides?.httpService ?? ({ get: jest.fn() } as any),
        {
          findByCode: jest.fn().mockResolvedValue({ id: 24, code: '24' }),
          getAll: jest.fn().mockResolvedValue(undefined),
        } as any,
        {
          findByCode: jest.fn().mockResolvedValue({ id: 1 }),
        } as any,
        {
          sendEmailsByDepartement: jest.fn().mockResolvedValue(undefined),
        } as any,
        {
          findByDepartement: jest.fn().mockResolvedValue([]),
        } as any,
        {} as any,
      ),
    };
  };

  it('extracts Sandre alternate codes serialized as a string array of JSON objects', async () => {
    const existingZone = { id: 12111 };
    const zoneAlerteRepository = {
      findOne: jest.fn().mockResolvedValue(existingZone),
      save: jest.fn().mockResolvedValue(existingZone),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const httpService = {
      get: jest.fn().mockReturnValue(
        of({
          data: {
            features: [
              {
                properties: {
                  gid: '1105',
                  CdDepartement: '24',
                  CodesAlternatifs: '{"{\\"code\\":\\"75_24_0006\\"}"}',
                  LbZAS: 'Dropt - Dropt aval',
                  TypeZAS: 'SUP',
                  NumeroVersionZAS: '4',
                  NumCircAdminBassin: '75',
                  RessInfluenceeZAS: 0,
                },
                geometry: {
                  type: 'MultiPolygon',
                  coordinates: [],
                },
              },
            ],
          },
        }),
      ),
    };
    const { service } = createService({
      zoneAlerteRepository,
      httpService,
    });

    await service.updateDepartementZones('24');

    expect(zoneAlerteRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        code: '75_24_0006',
        idSandre: 1105,
        disabled: false,
      }),
    );
  });

  it('falls back to department, type and code when the Sandre id is new', async () => {
    const existingZone = { id: 3901 };
    const zoneAlerteRepository = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existingZone),
      save: jest.fn().mockResolvedValue(existingZone),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const { service } = createService({ zoneAlerteRepository });

    const zone = await (service as any).findExistingSandreZone(
      1105,
      '24',
      'SUP',
      '75_24_0006',
    );

    expect(zone).toBe(existingZone);
    expect(zoneAlerteRepository.findOne).toHaveBeenNthCalledWith(1, {
      where: {
        idSandre: 1105,
      },
    });
    expect(zoneAlerteRepository.findOne).toHaveBeenNthCalledWith(2, {
      where: {
        code: '75_24_0006',
        departement: {
          code: '24',
        },
        type: 'SUP',
      },
    });
  });
});
