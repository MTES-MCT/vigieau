import { Test, TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { HEADERS_METADATA } from '@nestjs/common/constants';
import { ZonesController } from './zones.controller';
import { ZonesService } from './zones.service';
import { ZoneDto, ZonePublicationQueryDto } from './dto/zone.dto';

jest.mock('./zones.service', () => ({
  ZonesService: class ZonesService {},
}));

describe('ZonesController', () => {
  let zonesController: ZonesController;
  let zonesService: ZonesService;

  const mockZone: ZoneDto = {
    id: 1,
    idSandre: 123,
    gid: 456,
    code: '01_ZONE_SUP',
    CdZAS: '01_ZONE_SUP',
    nom: 'Zone de test',
    LbZAS: 'Zone de test',
    type: 'SUP',
    TypeZAS: 'SUP',
    ressourceInfluencee: true,
    niveauGravite: 'alerte',
    departement: '01',
    arrete: null,
    arreteMunicipalCheminFichier: null,
    usages: [],
  };

  const mockZonesService = {
    find: jest.fn(),
    findOne: jest.fn(),
    findByDepartement: jest.fn(),
    getPublication: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ZonesController],
      providers: [{ provide: ZonesService, useValue: mockZonesService }],
    }).compile();

    zonesController = <ZonesController>module.get(ZonesController);
    zonesService = <ZonesService>module.get(ZonesService);
  });

  it('should be defined', () => {
    expect(zonesController).toBeDefined();
  });

  describe('findAll', () => {
    it('should return a list of zones when called with valid query parameters', async () => {
      const mockResult = [mockZone];
      mockZonesService.find.mockResolvedValue(mockResult);

      const query = {
        lon: '2.123',
        lat: '48.123',
        commune: undefined,
        profil: undefined,
        zoneType: undefined,
      };
      const result = await zonesController.findAll(query);

      expect(zonesService.find).toHaveBeenCalledWith(
        query.lon,
        query.lat,
        query.commune,
        query.profil,
        query.zoneType,
        undefined,
      );
      expect(result).toEqual(mockResult);
    });
  });

  describe('findOne', () => {
    it('should return a zone when called with a valid id', async () => {
      mockZonesService.findOne.mockResolvedValue(mockZone);

      const result = await zonesController.findOne(1, {});

      expect(zonesService.findOne).toHaveBeenCalledWith(1, undefined);
      expect(result).toEqual(mockZone);
    });

    it('rejects a malformed publication id through the global validation contract', async () => {
      const pipe = new ValidationPipe({ transform: true });

      await expect(
        pipe.transform(
          { publicationId: 'not-a-uuid' },
          { type: 'query', metatype: ZonePublicationQueryDto },
        ),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('findByDepartement', () => {
    it('should return a list of zones for a valid department code', async () => {
      const mockResult = [mockZone];
      mockZonesService.findByDepartement.mockResolvedValue(mockResult);

      const result = await zonesController.findByDepartement('01', {});

      expect(zonesService.findByDepartement).toHaveBeenCalledWith(
        '01',
        undefined,
      );
      expect(result).toEqual(mockResult);
    });
  });

  describe('getPublication', () => {
    it('delegates publication resolution to the service', async () => {
      mockZonesService.getPublication.mockReturnValue({ id: '42' });

      await expect(zonesController.getPublication()).resolves.toEqual({
        id: '42',
      });
      expect(zonesService.getPublication).toHaveBeenCalled();
    });

    it('prevents intermediaries from caching the active manifest', () => {
      expect(
        Reflect.getMetadata(
          HEADERS_METADATA,
          ZonesController.prototype.getPublication,
        ),
      ).toContainEqual({ name: 'Cache-Control', value: 'no-store' });
    });
  });
});
