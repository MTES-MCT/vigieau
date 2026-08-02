import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { FindManyOptions, FindOptionsWhere, In, Repository } from 'typeorm';
import { Commune } from '@shared/entities/commune.entity';
import { CronExpression } from '@nestjs/schedule';
import { BusinessCron } from '../core/scheduling/business-cron';
import { DepartementService } from '../departement/departement.service';
import { firstValueFrom } from 'rxjs';
import { RegleauLogger } from '../logger/regleau.logger';
import { ConfigService } from '@nestjs/config';
import { User } from '@shared/entities/user.entity';
import { isDeepStrictEqual } from 'node:util';
import { shouldSkipStartupDataLoads } from '../core/startup-data-loads';

const MIN_COMMUNE_REFERENCE_COMPLETENESS_RATIO = 0.9;

interface CommuneReferencePayload {
  code: string;
  codeDepartement: string;
  nom: string;
  population: number | null;
  siren: string | null;
  contour: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: unknown[];
  };
}

@Injectable()
export class CommuneService {
  private readonly logger = new RegleauLogger('CommuneService');
  private readonly findCache = new Map<
    string,
    { expiresAt: number; value: Commune[] }
  >();
  private readonly findCacheFetches = new Map<string, Promise<Commune[]>>();
  private readonly findCacheTtlMs = 6 * 60 * 60 * 1000;
  private readonly findCacheMaxSize = 150;

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(Commune)
    private readonly communeRepository: Repository<Commune>,
    private readonly departementService: DepartementService,
    private readonly configService: ConfigService,
  ) {
    if (!shouldSkipStartupDataLoads()) {
      void this.initDatas();
    }
  }

  async initDatas() {
    const communes = await this.communeRepository.count();
    if (communes === 0) {
      this.updateCommuneRef();
    }
  }

  async find(
    depCodes?: string[],
    withGeom?: boolean,
    user?: User,
  ): Promise<Commune[]> {
    const cacheKey = this.getFindCacheKey(depCodes, withGeom, user);
    const cached = this.findCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    if (this.findCacheFetches.has(cacheKey)) {
      return this.findCacheFetches.get(cacheKey);
    }

    const fetchPromise = this.findFromDatabase(depCodes, withGeom, user)
      .then((communes) => {
        this.setFindCache(cacheKey, communes);
        return communes;
      })
      .finally(() => {
        this.findCacheFetches.delete(cacheKey);
      });

    this.findCacheFetches.set(cacheKey, fetchPromise);
    return fetchPromise;
  }

  private async findFromDatabase(
    depCodes?: string[],
    withGeom?: boolean,
    user?: User,
  ): Promise<Commune[]> {
    const qb = this.communeRepository
      .createQueryBuilder('commune')
      .select('commune.id', 'id')
      .addSelect('commune.code', 'code')
      .addSelect('commune.nom', 'nom');

    if (withGeom) {
      qb.addSelect('ST_AsGeoJSON(ST_TRANSFORM(commune.geom, 4326), 3)', 'geom');
    }

    qb.leftJoin('commune.departement', 'departement');

    if (depCodes && depCodes.length > 0) {
      qb.where('departement.code IN(:...depCodes)', { depCodes });
    }

    if (
      (!depCodes || depCodes.length < 1) &&
      user &&
      user.role === 'departement'
    ) {
      qb.where('departement.code IN (:...depCodes)', {
        depCodes: user.role_departements,
      });
    }

    if ((!depCodes || depCodes.length < 1) && user && user.role === 'commune') {
      qb.where('commune.code IN (:...communesCode)', {
        communesCode: user.role_communes,
      });
    }

    return qb.getRawMany();
  }

  private getFindCacheKey(
    depCodes?: string[],
    withGeom?: boolean,
    user?: User,
  ): string {
    const normalizedDepCodes = [
      ...new Set(depCodes?.filter(Boolean) || []),
    ].sort();
    let scope = 'all';

    if (normalizedDepCodes.length > 0) {
      scope = `dep:${normalizedDepCodes.join(',')}`;
    } else if (user?.role === 'departement') {
      scope = `user-dep:${[...new Set(user.role_departements || [])].sort().join(',')}`;
    } else if (user?.role === 'commune') {
      scope = `user-commune:${[...new Set(user.role_communes || [])].sort().join(',')}`;
    }

    return `${withGeom ? 'geom' : 'light'}:${scope}`;
  }

  private setFindCache(key: string, value: Commune[]): void {
    if (this.findCache.size >= this.findCacheMaxSize) {
      const oldestKey = this.findCache.keys().next().value;
      if (oldestKey) {
        this.findCache.delete(oldestKey);
      }
    }

    this.findCache.set(key, {
      expiresAt: Date.now() + this.findCacheTtlMs,
      value,
    });
  }

  private clearFindCache(): void {
    this.findCache.clear();
    this.findCacheFetches.clear();
  }

  findAllLight(): Promise<Commune[]> {
    return this.communeRepository.find(<FindManyOptions>{
      select: {
        id: true,
        code: true,
        nom: true,
        departement: {
          id: true,
          code: true,
        },
      },
      relations: ['departement'],
      order: {
        code: 'ASC',
      },
    });
  }

  findWithStats(
    take: number,
    skip: number,
    departementCodes?: string[],
  ): Promise<Commune[]> {
    const options: FindManyOptions<Commune> = {
      select: {
        id: true,
        code: true,
        nom: true,
        departement: {
          id: true,
          code: true,
        },
        statisticCommune: {
          id: true,
        },
      },
      relations: ['departement', 'statisticCommune'],
      order: {
        code: 'ASC',
      },
      take: take,
      skip: skip,
    };
    if (departementCodes?.length > 0) {
      options.where = {
        departement: {
          code: In(departementCodes),
        },
      };
    }
    return this.communeRepository.find(options);
  }

  findBySiren(siren: string) {
    return this.communeRepository.findOne({
      select: {
        id: true,
        code: true,
        nom: true,
      },
      where: {
        siren,
      },
    });
  }

  count(departementCodes?: string[]): Promise<number> {
    if (!departementCodes?.length) {
      return this.communeRepository.count();
    }
    return this.communeRepository.count({
      where: {
        departement: {
          code: In(departementCodes),
        },
      },
    });
  }

  getUnionGeomOfCommunes(communes: Commune[]): Promise<any> {
    return this.communeRepository
      .createQueryBuilder('commune')
      .select(
        'ST_AsGeoJSON(ST_UNION(ST_TRANSFORM(commune.geom, 4326)))',
        'geom',
      )
      .where('commune.id IN(:...communesId)', {
        communesId: communes.map((c) => c.id),
      })
      .getRawOne();
  }

  async getZoneAlerteComputedForHarmonisation(depId: number) {
    const rawMany = await this.communeRepository
      .createQueryBuilder('commune')
      .select('commune.id', 'id')
      .addSelect('commune.code', 'code')
      .addSelect('commune.nom', 'nom')
      .addSelect('zac.id', 'zac_id')
      .addSelect('zac.nom', 'zac_nom')
      .addSelect('zac.type', 'zac_type')
      .addSelect('zac.ressourceInfluencee', 'zac_ressource_influencee')
      .addSelect('zac.niveauGravite', 'zac_niveau_gravite')
      .addSelect('ST_Area(commune.geom)', 'area')
      .addSelect('ST_Area(zac.geom)', 'zac_area')
      .addSelect(
        'ST_Area(ST_Intersection(zac.geom, commune.geom))',
        'zac_commune_area',
      )
      .leftJoin(
        'zone_alerte_computed',
        'zac',
        `zac."departementId" = commune."departementId" and ST_Intersects(zac.geom, commune.geom)`,
      )
      .where('commune."departementId" = :depId', { depId })
      .andWhere('zac.id IS NOT NULL')
      .getRawMany();
    const toReturn = [];
    rawMany.forEach((c) => {
      if (!toReturn.find((t) => t.id === c.id)) {
        toReturn.push({
          id: c.id,
          code: c.code,
          nom: c.nom,
          area: c.area,
          zones: [],
        });
      }
      const commune = toReturn.find((t) => t.id === c.id);
      commune.zones.push({
        id: c.zac_id,
        nom: c.zac_nom,
        type: c.zac_type,
        ressourceInfluencee: c.zac_ressource_influencee,
        niveauGravite: c.zac_niveau_gravite,
        area: c.zac_area,
        areaCommune: c.zac_commune_area,
        areaCommunePercentage: (c.zac_commune_area / c.area) * 100,
      });
    });
    return toReturn;
  }

  async getZoneAlerteComputedHistoricForHarmonisation(depId: number) {
    const rawMany = await this.communeRepository
      .createQueryBuilder('commune')
      .select('commune.id', 'id')
      .addSelect('commune.code', 'code')
      .addSelect('commune.nom', 'nom')
      .addSelect('zac.id', 'zac_id')
      .addSelect('zac.nom', 'zac_nom')
      .addSelect('zac.type', 'zac_type')
      .addSelect('zac.ressourceInfluencee', 'zac_ressource_influencee')
      .addSelect('zac.niveauGravite', 'zac_niveau_gravite')
      .addSelect('ST_Area(commune.geom)', 'area')
      .addSelect('ST_Area(zac.geom)', 'zac_area')
      .addSelect(
        'ST_Area(ST_Intersection(zac.geom, commune.geom))',
        'zac_commune_area',
      )
      .leftJoin(
        'zone_alerte_computed_historic',
        'zac',
        `zac."departementId" = commune."departementId" and ST_Intersects(zac.geom, commune.geom)`,
      )
      .where('commune."departementId" = :depId', { depId })
      .andWhere('zac.id IS NOT NULL')
      .getRawMany();
    const toReturn = [];
    rawMany.forEach((c) => {
      if (!toReturn.find((t) => t.id === c.id)) {
        toReturn.push({
          id: c.id,
          code: c.code,
          nom: c.nom,
          area: c.area,
          zones: [],
        });
      }
      const commune = toReturn.find((t) => t.id === c.id);
      commune.zones.push({
        id: c.zac_id,
        nom: c.zac_nom,
        type: c.zac_type,
        niveauGravite: c.zac_niveau_gravite,
        area: c.zac_area,
        areaCommune: c.zac_commune_area,
        areaCommunePercentage: (c.zac_commune_area / c.area) * 100,
      });
    });
    return toReturn;
  }

  async getUserCommunes(user: User, communes: Commune[]) {
    const communesIds = communes.map((c) => c.id);
    const whereClause: FindOptionsWhere<Commune> | null =
      !user || user.role === 'mte'
        ? { id: In(communesIds) }
        : user.role === 'departement'
          ? {
              id: In(communesIds),
              departement: {
                code: In(user.role_departements),
              },
            }
          : {
              id: In(communesIds),
              code: In(user.role_communes),
            };

    return this.communeRepository.find({
      select: {
        id: true,
        code: true,
        nom: true,
      },
      relations: ['departement'],
      where: whereClause,
    });
  }

  @BusinessCron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async updateCommuneRef() {
    this.logger.log('MISE A JOUR DES COMMUNES');
    let communesUpdated = 0;
    let communesAdded = 0;
    let communesUnchanged = 0;
    const departements = await this.departementService.findAllLight();
    for (const d of departements) {
      const url = `${this.configService.get('API_GEO')}/departements/${d.code}/communes?fields=code,codeDepartement,nom,contour,population,siren`;
      const { data } = await firstValueFrom(this.httpService.get(url));
      const knownCommuneCount = await this.communeRepository.count({
        where: { departement: { id: d.id } },
      });
      this.assertCompleteCommuneResponse(data, d.code, knownCommuneCount);
      if (knownCommuneCount === 0) {
        await this.assertBootstrapCommuneResponse(data, d.code);
      }
      await Promise.all(
        data.map(async (c) => {
          const communeExisting = await this.communeRepository.findOne({
            select: {
              id: true,
              code: true,
              nom: true,
              population: true,
              siren: true,
              geom: true,
              departement: {
                id: true,
              },
            },
            relations: ['departement'],
            where: { code: c.code },
          });
          if (communeExisting) {
            const population = c.population;
            const siren = c.siren;
            const geom = c.contour as Commune['geom'];
            const geometryMatches = await this.geometryMatches(
              communeExisting.id,
              c.code,
              communeExisting.geom ?? null,
              geom,
            );
            const hasChanged =
              communeExisting.nom !== c.nom ||
              communeExisting.departement?.id !== d.id ||
              communeExisting.population !== population ||
              communeExisting.siren !== siren ||
              !geometryMatches;

            if (!hasChanged) {
              communesUnchanged++;
              return;
            }

            communeExisting.nom = c.nom;
            communeExisting.departement = d;
            communeExisting.population = population;
            communeExisting.siren = siren;
            communeExisting.geom = geom;
            await this.communeRepository.save(communeExisting);
            communesUpdated++;
          } else {
            const geom = c.contour as Commune['geom'];
            await this.assertValidGeometry(c.code, geom);
            await this.communeRepository.save({
              code: c.code,
              nom: c.nom,
              population: c.population ?? null,
              siren: c.siren ?? null,
              geom,
              departement: d,
            });
            communesAdded++;
          }
        }),
      );
    }
    this.clearFindCache();
    this.logger.log(`${communesUpdated} COMMUNES MIS A JOUR`);
    this.logger.log(`${communesAdded} COMMUNES AJOUTEES`);
    this.logger.log(`${communesUnchanged} COMMUNES INCHANGEES`);
  }

  private assertCompleteCommuneReference(
    commune: Record<string, unknown>,
    departementCode: string,
  ): void {
    const hasOwn = (key: string) =>
      Object.prototype.hasOwnProperty.call(commune, key);
    const contour = commune.contour as
      | { type?: unknown; coordinates?: unknown }
      | undefined;
    const isComplete =
      typeof commune.code === 'string' &&
      commune.code.length > 0 &&
      commune.codeDepartement === departementCode &&
      typeof commune.nom === 'string' &&
      commune.nom.length > 0 &&
      hasOwn('population') &&
      (commune.population === null ||
        (typeof commune.population === 'number' &&
          Number.isFinite(commune.population) &&
          commune.population >= 0)) &&
      hasOwn('siren') &&
      (commune.siren === null ||
        (typeof commune.siren === 'string' && commune.siren.length > 0)) &&
      hasOwn('contour') &&
      contour !== null &&
      typeof contour === 'object' &&
      (contour.type === 'Polygon' || contour.type === 'MultiPolygon') &&
      Array.isArray(contour.coordinates) &&
      contour.coordinates.length > 0;

    if (!isComplete) {
      throw new Error(
        `Incomplete commune reference payload for department ${departementCode}`,
      );
    }
  }

  private assertCompleteCommuneResponse(
    communes: unknown,
    departementCode: string,
    knownCommuneCount: number,
  ): asserts communes is CommuneReferencePayload[] {
    if (!Array.isArray(communes) || communes.length === 0) {
      throw new Error(
        `Incomplete commune reference payload for department ${departementCode}`,
      );
    }
    communes.forEach((commune) =>
      this.assertCompleteCommuneReference(commune, departementCode),
    );
    const uniqueCodes = new Set(communes.map(({ code }) => code));
    const minimumExpectedCount = Math.ceil(
      knownCommuneCount * MIN_COMMUNE_REFERENCE_COMPLETENESS_RATIO,
    );
    if (
      uniqueCodes.size !== communes.length ||
      (knownCommuneCount > 0 && communes.length < minimumExpectedCount)
    ) {
      throw new Error(
        `Incomplete commune reference payload for department ${departementCode}`,
      );
    }
  }

  private async geometryMatches(
    communeId: number,
    communeCode: string,
    currentGeom: unknown,
    incomingGeom: unknown,
  ): Promise<boolean> {
    if (isDeepStrictEqual(currentGeom, incomingGeom)) {
      return true;
    }
    if (incomingGeom === null) {
      return false;
    }
    if (currentGeom === null) {
      await this.assertValidGeometry(communeCode, incomingGeom);
      return false;
    }

    const [result] = await this.communeRepository.query(
      `
        WITH "incoming" AS (
          SELECT ST_SetSRID(
            ST_GeomFromGeoJSON($2::text),
            ST_SRID("geom")
          ) AS "geom"
          FROM "commune"
          WHERE "id" = $1
        )
        SELECT
          ST_IsValid("incoming"."geom")
            AND NOT ST_IsEmpty("incoming"."geom") AS "valid",
          ST_Equals("commune"."geom", "incoming"."geom") AS "matches"
        FROM "commune"
        CROSS JOIN "incoming"
        WHERE "commune"."id" = $1
      `,
      [communeId, JSON.stringify(incomingGeom)],
    );
    if (result?.valid !== true) {
      throw new Error(`Invalid commune geometry for ${communeCode}`);
    }
    return result?.matches === true;
  }

  private async assertBootstrapCommuneResponse(
    communes: CommuneReferencePayload[],
    departementCode: string,
  ): Promise<void> {
    const url = `${this.configService.get('API_GEO')}/communes?codeDepartement=${encodeURIComponent(departementCode)}&fields=code,codeDepartement`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    const indexIsComplete =
      Array.isArray(data) &&
      data.length > 0 &&
      data.every(
        (commune) =>
          commune !== null &&
          typeof commune === 'object' &&
          typeof commune.code === 'string' &&
          commune.code.length > 0 &&
          commune.codeDepartement === departementCode,
      );
    if (!indexIsComplete) {
      throw new Error(
        `Incomplete commune reference payload for department ${departementCode}`,
      );
    }

    const detailedCodes = new Set(communes.map(({ code }) => code));
    const indexedCodes = new Set(
      (data as Array<{ code: string }>).map(({ code }) => code),
    );
    if (
      indexedCodes.size !== data.length ||
      detailedCodes.size !== indexedCodes.size ||
      ![...indexedCodes].every((code) => detailedCodes.has(code))
    ) {
      throw new Error(
        `Incomplete commune reference payload for department ${departementCode}`,
      );
    }
  }

  private async assertValidGeometry(
    communeCode: string,
    geom: unknown,
  ): Promise<void> {
    const [result] = await this.communeRepository.query(
      `
        WITH "incoming" AS (
          SELECT ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326) AS "geom"
        )
        SELECT ST_IsValid("geom") AND NOT ST_IsEmpty("geom") AS "valid"
        FROM "incoming"
      `,
      [JSON.stringify(geom)],
    );
    if (result?.valid !== true) {
      throw new Error(`Invalid commune geometry for ${communeCode}`);
    }
  }
}
