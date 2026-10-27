import { Test, TestingModule } from '@nestjs/testing';
import { SubscriptionsService } from './subscriptions.service';
import { Repository } from 'typeorm';
import { CommunesService } from '../communes/communes.service';
import { HttpService } from '@nestjs/axios';
import { ZonesService } from '../zones/zones.service';
import { BrevoService } from '../brevo/brevo.service';
import { MattermostService } from '../mattermost/mattermost.service';
import { CronService } from '../cron/cron.service';
import { AbonnementMail } from '@shared/entities/abonnement_mail.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { of, throwError } from 'rxjs';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { AxiosResponse } from 'axios';

describe('SubscriptionsService', () => {
  let service: SubscriptionsService;
  let abonnementMailRepository: Repository<AbonnementMail>;
  let communesService: CommunesService;
  let zonesService: ZonesService;
  let brevoService: BrevoService;
  let httpService: HttpService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionsService,
        {
          provide: getRepositoryToken(AbonnementMail),
          useClass: Repository,
        },
        {
          provide: CommunesService,
          useValue: {
            getCommune: jest.fn(),
          },
        },
        {
          provide: HttpService,
          useValue: {
            get: jest.fn(),
          },
        },
        {
          provide: ZonesService,
          useValue: {
            searchZonesByLonLat: jest.fn(),
            searchZonesByCommune: jest.fn(),
            loadAllZones: jest.fn(),
          },
        },
        {
          provide: BrevoService,
          useValue: {
            sendMail: jest.fn(),
            computeUnsubscribeUrl: jest.fn(),
            sendSituationUpdate: jest.fn(),
          },
        },
        {
          provide: MattermostService,
          useValue: {
            sendMessage: jest.fn(),
          },
        },
        {
          provide: CronService,
          useValue: {
            askForLock: jest.fn(),
            unlock: jest.fn(),
          },
        },
      ],
    }).compile();

    service = <SubscriptionsService>module.get(SubscriptionsService);
    abonnementMailRepository = <Repository<AbonnementMail>>(
      module.get(getRepositoryToken(AbonnementMail))
    );
    communesService = <CommunesService>module.get(CommunesService);
    zonesService = <ZonesService>module.get(ZonesService);
    brevoService = <BrevoService>module.get(BrevoService);
    httpService = <HttpService>module.get(HttpService);
    jest.spyOn((service as any).logger, 'warn').mockImplementation();
    jest.spyOn((service as any).logger, 'error').mockImplementation();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getAllLight', () => {
    it('should return all subscriptions with selected fields', async () => {
      const mockData = [
        { id: 1, email: 'test@test.com', createdAt: Date.now() },
      ];
      jest
        .spyOn(abonnementMailRepository, 'find')
        .mockResolvedValue(mockData as AbonnementMail[]);

      const result = await service.getAllLight();
      expect(result).toEqual(mockData);
      expect(abonnementMailRepository.find).toHaveBeenCalledWith({
        select: ['id', 'email', 'createdAt'],
      });
    });
  });

  describe('create', () => {
    it('should create a subscription and send a confirmation email', async () => {
      const mockSubscription = {
        email: 'test@test.com',
        profil: 'particulier',
        commune: '12345',
        typesEau: ['AEP'],
      };
      const mockCommune = { nom: 'Test Commune' };
      const mockSavedSubscription = {
        ...mockSubscription,
        id: 1,
        createdAt: new Date(),
        situation: {},
      };

      jest
        .spyOn(communesService, 'getCommune')
        .mockReturnValue(
          mockCommune as ReturnType<CommunesService['getCommune']>,
        );
      jest.spyOn(abonnementMailRepository, 'exists').mockResolvedValue(false);
      jest
        .spyOn(abonnementMailRepository, 'save')
        .mockResolvedValue(mockSavedSubscription as any);
      jest.spyOn(brevoService, 'sendMail').mockResolvedValue(undefined);

      const result = await service.create(mockSubscription as any, '127.0.0.1');
      expect(result).toEqual({
        ...mockSubscription,
        ip: '127.0.0.1',
        libelleLocalisation: 'Test Commune',
        situation: {},
      });
      expect(abonnementMailRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'test@test.com',
          commune: '12345',
          libelleLocalisation: 'Test Commune',
          typesEau: ['AEP'],
        }),
      );
      expect(brevoService.sendMail).toHaveBeenCalledWith(
        29,
        'test@test.com',
        expect.objectContaining({
          city: 'Test Commune',
        }),
      );
    });

    it('should update an existing subscription if it already exists', async () => {
      const mockSubscription = {
        email: 'test@test.com',
        profil: 'particulier',
        commune: '12345',
        typesEau: ['AEP'],
      };

      jest
        .spyOn(communesService, 'getCommune')
        .mockReturnValue({ nom: 'Test Commune' } as any);
      jest.spyOn(abonnementMailRepository, 'exists').mockResolvedValue(true);
      jest
        .spyOn(abonnementMailRepository, 'update')
        .mockResolvedValue(undefined);

      const result = await service.create(mockSubscription as any, '127.0.0.1');
      expect(result).toEqual({
        email: 'test@test.com',
        profil: 'particulier',
        commune: '12345',
        typesEau: ['AEP'],
        ip: '127.0.0.1',
        libelleLocalisation: 'Test Commune',
        situation: {},
      });
      expect(abonnementMailRepository.update).toHaveBeenCalled();
    });

    it('should use the address commune name when the commune is not loaded locally', async () => {
      const mockSubscription = {
        email: 'test@test.com',
        profil: 'particulier',
        idAdresse: 'address-id',
        lon: 2.3522,
        lat: 48.8566,
        typesEau: ['AEP'],
      };
      const mockAddress = {
        data: {
          commune: { code: '75056', nom: 'Paris' },
          type: 'numero',
          numero: '10',
          voie: { nomVoie: 'Rue de Rivoli' },
        },
      };

      jest
        .spyOn(httpService, 'get')
        .mockReturnValue(of(mockAddress as AxiosResponse));
      jest.spyOn(communesService, 'getCommune').mockReturnValue(undefined);
      jest.spyOn(zonesService, 'searchZonesByLonLat').mockReturnValue([]);
      jest.spyOn(abonnementMailRepository, 'exists').mockResolvedValue(false);
      jest.spyOn(abonnementMailRepository, 'save').mockResolvedValue({
        ...mockSubscription,
        commune: '75056',
        libelleLocalisation: '10, Rue de Rivoli, Paris',
      } as any);
      jest.spyOn(brevoService, 'sendMail').mockResolvedValue(undefined);

      const result = await service.create(mockSubscription as any, '127.0.0.1');

      expect(result).toEqual(
        expect.objectContaining({
          commune: '75056',
          libelleLocalisation: '10, Rue de Rivoli, Paris',
        }),
      );
      expect(brevoService.sendMail).toHaveBeenCalledWith(
        29,
        'test@test.com',
        expect.objectContaining({
          city: 'Paris',
          address: '10, Rue de Rivoli, Paris',
        }),
      );
    });

    it('should create a coordinate subscription without a commune name', async () => {
      const mockSubscription = {
        email: 'test@test.com',
        profil: 'particulier',
        lon: 2.3522,
        lat: 48.8566,
        typesEau: ['AEP'],
      };

      jest.spyOn(zonesService, 'searchZonesByLonLat').mockReturnValue([]);
      jest.spyOn(abonnementMailRepository, 'exists').mockResolvedValue(false);
      jest
        .spyOn(abonnementMailRepository, 'save')
        .mockResolvedValue(mockSubscription as any);
      jest.spyOn(brevoService, 'sendMail').mockResolvedValue(undefined);

      await service.create(mockSubscription as any, '127.0.0.1');

      expect(brevoService.sendMail).toHaveBeenCalledWith(
        29,
        'test@test.com',
        expect.objectContaining({
          city: '',
        }),
      );
    });

    it('should throw an error if commune is invalid', async () => {
      jest.spyOn(communesService, 'getCommune').mockReturnValue(null);

      await expect(
        service.create({ commune: 'invalid' } as any, '127.0.0.1'),
      ).rejects.toThrow(HttpException);
    });

    it.each([
      { lon: undefined, lat: 48 },
      { lon: 2, lat: NaN },
      { lon: Infinity, lat: 48 },
      { lon: 181, lat: 48 },
    ])(
      'should reject invalid address coordinates without external calls: %p',
      async (coordinates) => {
        await expect(
          service.create(
            { idAdresse: '75056_0001_00010', ...coordinates } as any,
            '127.0.0.1',
          ),
        ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
        expect(httpService.get).not.toHaveBeenCalled();
      },
    );

    it('should accept zero coordinates for an address', async () => {
      jest.spyOn(service, 'resolveIdAdresse').mockResolvedValue({
        libelle: 'Address',
        commune: '12345',
        communeNom: 'City',
      });
      jest.spyOn(abonnementMailRepository, 'exists').mockResolvedValue(true);
      jest
        .spyOn(abonnementMailRepository, 'update')
        .mockResolvedValue(undefined);
      await service.create(
        {
          idAdresse: '12345_0001_00010',
          lon: 0,
          lat: 48,
          email: 'test@example.com',
          typesEau: ['AEP'],
        } as any,
        '127.0.0.1',
      );
      expect(service.resolveIdAdresse).toHaveBeenCalledWith(
        '12345_0001_00010',
        expect.objectContaining({ lon: 0, lat: 48 }),
      );
    });

    it('should not save or send mail when neither provider can verify the address', async () => {
      const exists = jest.spyOn(abonnementMailRepository, 'exists');
      const save = jest.spyOn(abonnementMailRepository, 'save');
      const update = jest.spyOn(abonnementMailRepository, 'update');
      jest
        .spyOn(httpService, 'get')
        .mockReturnValue(throwError(() => ({ response: { status: 503 } })));
      await expect(
        service.create(
          {
            idAdresse: '75056_0001_00010',
            lon: 2,
            lat: 48,
            email: 'test@example.com',
            typesEau: ['AEP'],
          } as any,
          '127.0.0.1',
        ),
      ).rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
      expect(exists).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(brevoService.sendMail).not.toHaveBeenCalled();
    });
  });

  describe('resolveIdAdresse', () => {
    const id = '75056_0001_00010';
    const coordinates = { lon: 2.35, lat: 48.85 };
    const feature = () => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [2.35, 48.85] },
      properties: {
        id,
        type: 'housenumber',
        label: '10 Rue de Rivoli 75004 Paris',
        citycode: '75056',
        city: 'Paris',
      },
    });
    const collection = (features: any[] = [feature()]) => ({
      data: { type: 'FeatureCollection', features },
    });

    it('should resolve address ID successfully', async () => {
      const mockAddress = {
        data: {
          commune: { code: '12345', nom: 'City' },
          type: 'numero',
          numero: '10',
          voie: { nomVoie: 'Main St' },
        },
      };

      jest
        .spyOn(httpService, 'get')
        .mockReturnValue(of(mockAddress as AxiosResponse));

      const result = await service.resolveIdAdresse('123');
      expect(result).toEqual({
        libelle: '10, Main St, City',
        commune: '12345',
        communeNom: 'City',
      });
      expect(httpService.get).toHaveBeenCalledTimes(1);
      expect(httpService.get).toHaveBeenCalledWith(
        'https://plateforme.adresse.data.gouv.fr/lookup/123',
        { timeout: 3000 },
      );
    });

    it.each([400, 404])(
      'should return 400 for an invalid address ID (upstream %i)',
      async (status) => {
        jest
          .spyOn(httpService, 'get')
          .mockReturnValue(throwError(() => ({ response: { status } })));

        await expect(
          service.resolveIdAdresse('invalid', coordinates),
        ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
        expect(httpService.get).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      { response: { status: 503 } },
      { response: { status: 429 } },
      { code: 'ECONNABORTED' },
      { code: 'ETIMEDOUT' },
      { code: 'ECONNRESET' },
    ])(
      'should resolve the exact address through the fallback after %p',
      async (error) => {
        jest
          .spyOn(httpService, 'get')
          .mockReturnValueOnce(throwError(() => error))
          .mockReturnValueOnce(of(collection()) as any);
        await expect(
          service.resolveIdAdresse(id, coordinates),
        ).resolves.toEqual({
          libelle: '10 Rue de Rivoli 75004 Paris',
          commune: '75056',
          communeNom: 'Paris',
        });
        expect(httpService.get).toHaveBeenLastCalledWith(
          'https://data.geopf.fr/geocodage/reverse',
          {
            timeout: 3000,
            params: {
              ...coordinates,
              index: 'address',
              limit: 50,
              type: 'housenumber',
            },
          },
        );
      },
    );

    it('should fall back for a malformed primary response', async () => {
      jest
        .spyOn(httpService, 'get')
        .mockReturnValueOnce(of({ data: '<html>maintenance</html>' }) as any)
        .mockReturnValueOnce(of(collection()) as any);
      await expect(
        service.resolveIdAdresse(id, coordinates),
      ).resolves.toMatchObject({ commune: '75056' });
    });

    it.each([
      { data: null },
      {
        data: {
          commune: { code: 'wrong', nom: 'Paris' },
          type: 'voie',
          nomVoie: 'Rue',
        },
      },
      {
        data: {
          commune: { code: '75056', nom: '' },
          type: 'voie',
          nomVoie: 'Rue',
        },
      },
      { data: { commune: { code: '75056', nom: 'Paris' }, type: 'numero' } },
      {
        data: {
          commune: { code: '75056', nom: 'Paris' },
          type: 'numero',
          numero: {},
          voie: { nomVoie: 'Rue' },
        },
      },
      { data: { commune: { code: '75056', nom: 'Paris' }, type: 'other' } },
    ])(
      'should return 503 for malformed primary data without coordinates: %p',
      async (result) => {
        jest.spyOn(httpService, 'get').mockReturnValue(of(result) as any);
        await expect(service.resolveIdAdresse(id)).rejects.toMatchObject({
          status: HttpStatus.SERVICE_UNAVAILABLE,
        });
        expect(httpService.get).toHaveBeenCalledTimes(1);
      },
    );

    it('should not accept the nearest address when its ID differs', async () => {
      const neighbor = feature();
      neighbor.properties.id = '75056_0001_00012';
      jest
        .spyOn(httpService, 'get')
        .mockReturnValueOnce(throwError(() => ({ response: { status: 503 } })))
        .mockReturnValueOnce(of(collection([neighbor])) as any);
      await expect(
        service.resolveIdAdresse(id, coordinates),
      ).rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
    });

    it('should find the exact ID even when it is not the nearest result', async () => {
      const neighbor = feature();
      neighbor.properties.id = '75056_0001_00012';
      jest
        .spyOn(httpService, 'get')
        .mockReturnValueOnce(throwError(() => ({ response: { status: 503 } })))
        .mockReturnValueOnce(of(collection([neighbor, feature()])) as any);
      await expect(
        service.resolveIdAdresse(id, coordinates),
      ).resolves.toMatchObject({ commune: '75056' });
    });

    it.each([
      'geometry',
      'coordinates',
      'citycode',
      'city',
      'label',
      'type',
      'duplicate',
    ])('should reject malformed or ambiguous fallback %s', async (field) => {
      const invalid: any = feature();
      if (field === 'geometry') invalid.geometry.type = 'Polygon';
      else if (field === 'coordinates')
        invalid.geometry.coordinates = [Infinity, 48];
      else if (field !== 'duplicate')
        invalid.properties[field] = field === 'citycode' ? 'wrong' : '';
      jest
        .spyOn(httpService, 'get')
        .mockReturnValueOnce(throwError(() => ({ response: { status: 503 } })))
        .mockReturnValueOnce(
          of(
            collection(field === 'duplicate' ? [invalid, invalid] : [invalid]),
          ) as any,
        );
      await expect(
        service.resolveIdAdresse(id, coordinates),
      ).rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
    });

    it('should support a locality with the exact selected ID', async () => {
      const locality = feature();
      locality.properties.id = '75056_0001';
      locality.properties.type = 'locality';
      jest
        .spyOn(httpService, 'get')
        .mockReturnValueOnce(throwError(() => ({ response: { status: 503 } })))
        .mockReturnValueOnce(of(collection([])) as any)
        .mockReturnValueOnce(of(collection([locality])) as any);
      await expect(
        service.resolveIdAdresse(locality.properties.id, coordinates),
      ).resolves.toMatchObject({ commune: '75056' });
      expect(httpService.get).toHaveBeenLastCalledWith(
        'https://data.geopf.fr/geocodage/reverse',
        expect.objectContaining({
          params: expect.objectContaining({ type: 'locality' }),
        }),
      );
    });

    it('should return an actionable 503 without leaking provider errors or user data', async () => {
      jest.spyOn(httpService, 'get').mockReturnValue(
        throwError(() => ({
          response: { status: 503 },
          message: 'private-address',
          config: { headers: { Authorization: 'secret' } },
        })),
      );
      await expect(
        service.resolveIdAdresse(id, coordinates),
      ).rejects.toMatchObject({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        message: expect.stringContaining('sélectionnez un point sur la carte'),
      });
      const logs = JSON.stringify((service as any).logger.warn.mock.calls);
      expect(logs).not.toMatch(/private-address|secret|75056_0001_00010/);
      expect(logs).toContain('503');
    });

    it('should encode the ID as a single URL path component', async () => {
      jest
        .spyOn(httpService, 'get')
        .mockReturnValue(throwError(() => ({ response: { status: 404 } })));
      await expect(
        service.resolveIdAdresse('../other?token=value'),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      expect(httpService.get).toHaveBeenCalledWith(
        'https://plateforme.adresse.data.gouv.fr/lookup/..%2Fother%3Ftoken%3Dvalue',
        expect.any(Object),
      );
    });
  });

  describe('computeNiveauxAlerte', () => {
    it('should compute alert levels for a location', () => {
      jest
        .spyOn(zonesService, 'searchZonesByLonLat')
        .mockReturnValue([
          { type: 'AEP', niveauGravite: 'vigilance', idZone: 1 },
        ]);

      const result = service.computeNiveauxAlerte({
        lon: 1,
        lat: 1,
        commune: '12345',
      });
      expect(result).toEqual({
        AEP: 'vigilance',
        SOU: 'pas_restriction',
        SUP: 'pas_restriction',
        zones: [1],
      });
    });

    it('should not interpret missing commune data as no restrictions', () => {
      jest
        .spyOn(zonesService, 'searchZonesByCommune')
        .mockReturnValue(undefined);
      expect(() =>
        service.computeNiveauxAlerte({ commune: '12345' } as any),
      ).toThrow(
        'Les données de restrictions sont momentanément indisponibles.',
      );
    });

    it('should use coordinate search when longitude is zero', () => {
      jest.spyOn(zonesService, 'searchZonesByLonLat').mockReturnValue([]);
      service.computeNiveauxAlerte({ lon: 0, lat: 48, commune: '12345' });
      expect(zonesService.searchZonesByLonLat).toHaveBeenCalledWith({
        lon: 0,
        lat: 48,
      });
    });
  });

  describe('stored subscription coordinates', () => {
    it('should keep precise coordinate search for PostgreSQL decimal strings', () => {
      jest.spyOn(zonesService, 'searchZonesByLonLat').mockReturnValue([]);
      service.computeNiveauxAlerte({
        lon: '3.161103',
        lat: '43.395678',
        commune: '12345',
      });
      expect(zonesService.searchZonesByLonLat).toHaveBeenCalledWith({
        lon: 3.161103,
        lat: 43.395678,
      });
      expect(zonesService.searchZonesByCommune).not.toHaveBeenCalled();
    });

    it.each([null, undefined, '', ' ', 'invalid', '0x10', '3.14junk'])(
      'should not coerce a missing or malformed coordinate to a point: %p',
      (lon) => {
        jest.spyOn(zonesService, 'searchZonesByCommune').mockReturnValue([]);
        expect(() =>
          service.computeNiveauxAlerte({ lon, lat: '48', commune: '12345' }),
        ).toThrow('Les coordonnées de cet abonnement sont invalides.');
        expect(zonesService.searchZonesByLonLat).not.toHaveBeenCalled();
        expect(zonesService.searchZonesByCommune).not.toHaveBeenCalled();
      },
    );

    it('should use commune search when both coordinates are absent', () => {
      jest.spyOn(zonesService, 'searchZonesByCommune').mockReturnValue([]);
      service.computeNiveauxAlerte({ lon: null, lat: null, commune: '12345' });
      expect(zonesService.searchZonesByLonLat).not.toHaveBeenCalled();
      expect(zonesService.searchZonesByCommune).toHaveBeenCalledWith('12345');
    });
  });

  describe('updateSituations', () => {
    it('should not update restrictions or email subscribers when commune data is unavailable', async () => {
      jest.spyOn(abonnementMailRepository, 'find').mockResolvedValue([
        {
          id: 1,
          email: 'test@example.com',
          commune: '12345',
          typesEau: ['AEP'],
          situation: { AEP: 'crise' },
        },
      ] as any);
      const update = jest.spyOn(abonnementMailRepository, 'update');
      jest
        .spyOn(service, 'sendMattermostNotification')
        .mockResolvedValue(undefined);
      await service.updateSituations();
      expect(update).not.toHaveBeenCalled();
      expect(brevoService.sendSituationUpdate).not.toHaveBeenCalled();
      expect(service.sendMattermostNotification).toHaveBeenCalledWith(
        expect.objectContaining({ erreur: 1, mail_envoye: 0 }),
      );
    });
  });
});
