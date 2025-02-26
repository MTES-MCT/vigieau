import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { FindManyOptions, FindOptionsWhere, In, Repository } from 'typeorm';
import { Commune } from '@shared/entities/commune.entity';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DepartementService } from '../departement/departement.service';
import { firstValueFrom } from 'rxjs';
import { RegleauLogger } from '../logger/regleau.logger';
import { ConfigService } from '@nestjs/config';
import { User } from '@shared/entities/user.entity';

@Injectable()
export class CommuneService {
  private readonly logger = new RegleauLogger('CommuneService');

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(Commune)
    private readonly communeRepository: Repository<Commune>,
    private readonly departementService: DepartementService,
    private readonly configService: ConfigService,
  ) {
    this.initDatas();
  }

  async initDatas() {
    const communes = await this.communeRepository.count();
    if (communes === 0) {
      this.updateCommuneRef();
    }
  }

  async find(depCodes?: string[], withGeom?: boolean, user?: User): Promise<Commune[]> {
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

    if ((!depCodes || depCodes.length < 1) && user && user.role === 'departement') {
      qb.where('departement.code IN (:...depCodes)', { depCodes: user.role_departements });
    }

    if ((!depCodes || depCodes.length < 1) && user && user.role === 'commune') {
      qb.where('commune.code IN (:...communesCode)', { communesCode: user.role_communes });
    }

    return qb
      .getRawMany();
  }

  findAllLight(): Promise<Commune[]> {
    return this.communeRepository.find(<FindManyOptions> {
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

  findWithStats(take: number, skip: number): Promise<Commune[]> {
    return this.communeRepository.find(<FindManyOptions> {
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
    });
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

  count(): Promise<number> {
    return this.communeRepository.count();
  }

  getUnionGeomOfCommunes(communes: Commune[]): Promise<any> {
    return this.communeRepository
      .createQueryBuilder('commune')
      .select('ST_AsGeoJSON(ST_UNION(ST_TRANSFORM(commune.geom, 4326)))', 'geom')
      .where('commune.id IN(:...communesId)', { communesId: communes.map((c) => c.id) })
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
      .addSelect('ST_Area(ST_Intersection(zac.geom, commune.geom))', 'zac_commune_area')
      .leftJoin('zone_alerte_computed', 'zac', `zac."departementId" = commune."departementId" and ST_Intersects(zac.geom, commune.geom)`)
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
      .addSelect('ST_Area(ST_Intersection(zac.geom, commune.geom))', 'zac_commune_area')
      .leftJoin('zone_alerte_computed_historic', 'zac', `zac."departementId" = commune."departementId" and ST_Intersects(zac.geom, commune.geom)`)
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
    const communesIds = communes.map(c => c.id);
    const whereClause: FindOptionsWhere<Commune> | null =
      !user || user.role === 'mte'
        ? { id: In(communesIds) }
        : user.role === 'departement' ? {
          id: In(communesIds),
          departement: {
            code: In(user.role_departements),
          },
        } : {
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

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async updateCommuneRef() {
    this.logger.log('MISE A JOUR DES COMMUNES');
    let communesUpdated = 0;
    let communesAdded = 0;
    const departements = await this.departementService.findAllLight();
    for (const d of departements) {
      const url = `${this.configService.get('API_GEO')}/departements/${d.code}/communes?fields=code,nom,contour,population,siren`;
      const { data } = await firstValueFrom(this.httpService.get(url));
      await Promise.all(data.map(async c => {
        const communeExisting = await this.communeRepository.findOne({
          where: { code: c.code },
        });
        if (communeExisting) {
          communeExisting.nom = c.nom;
          communeExisting.departement = d;
          communeExisting.population = c.population;
          communeExisting.siren = c.siren;
          communeExisting.geom = c.contour;
          await this.communeRepository.save(communeExisting);
          communesUpdated++;
        } else {
          await this.communeRepository.save({
            code: c.code,
            nom: c.nom,
            population: c.population,
            siren: c.siren,
            geom: c.contour,
            departement: d,
          });
          communesAdded++;
        }
      }));
    }
    this.logger.log(`${communesUpdated} COMMUNES MIS A JOUR`);
    this.logger.log(`${communesAdded} COMMUNES AJOUTEES`);
  }
}
