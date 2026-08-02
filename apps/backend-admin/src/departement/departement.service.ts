import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronExpression } from '@nestjs/schedule';
import { BusinessCron } from '../core/scheduling/business-cron';
import { InjectRepository } from '@nestjs/typeorm';
import { Departement } from '@shared/entities/departement.entity';
import { firstValueFrom } from 'rxjs';
import { Repository } from 'typeorm';
import { AbonnementMailService } from '../abonnement_mail/abonnement_mail.service';
import { RegleauLogger } from '../logger/regleau.logger';
import { parseDepartementGeometryFeed } from './departement-geometry';
import { shouldSkipStartupDataLoads } from '../core/startup-data-loads';

const DEFAULT_DEPARTEMENTS_GEOJSON_URL =
  'https://etalab-datasets.geo.data.gouv.fr/contours-administratifs/2023/geojson/departements-5m.geojson';

@Injectable()
export class DepartementService {
  private readonly logger = new RegleauLogger('DepartementService');
  private departements;

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(Departement)
    private readonly departementRepository: Repository<Departement>,
    private readonly configService: ConfigService,
    private readonly abonnementMailService: AbonnementMailService,
  ) {
    // this.updateDepartementsGeom();
    if (!shouldSkipStartupDataLoads()) {
      void this.getAll();
    }
  }

  findAll(): Promise<Departement[]> {
    return this.departements;
  }

  async getAll() {
    this.departements = await this.departementRepository
      .createQueryBuilder('departement')
      .select([
        'departement.id',
        'departement.code',
        'departement.nom',
        'zonesAlerte.id',
        'zonesAlerte.nom',
        'zonesAlerte.code',
        'zonesAlerte.type',
        'zonesAlerte.ressourceInfluencee',
        'arretesCadre.id',
      ])
      .leftJoin(
        'departement.zonesAlerte',
        'zonesAlerte',
        'zonesAlerte.disabled = false',
      )
      .leftJoin(
        'zonesAlerte.arretesCadre',
        'arretesCadre',
        'arretesCadre.statut IN (:...acStatut)',
        { acStatut: ['a_venir', 'publie'] },
      )
      .orderBy('departement.code', 'ASC')
      .addOrderBy('zonesAlerte.code', 'ASC')
      .getMany();

    await Promise.all(
      this.departements.map(async (d) => {
        d.subscriptions =
          await this.abonnementMailService.getCountByDepartement(d.code);
        return d;
      }),
    );
  }

  findAllLight(): Promise<Departement[]> {
    return this.departementRepository
      .createQueryBuilder('departement')
      .select(['departement.id', 'departement.code', 'departement.nom'])
      .leftJoinAndSelect('departement.parametres', 'parametres')
      .orderBy('departement.code', 'ASC')
      .getMany();
  }

  find(departementId: number): Promise<Departement> {
    return this.departementRepository.findOne({
      select: ['id', 'code', 'nom'],
      where: {
        id: departementId,
      },
    });
  }

  findByCode(departementCode: string): Promise<Departement> {
    return this.departementRepository.findOne({
      select: ['id', 'code', 'nom'],
      where: {
        code: departementCode,
      },
    });
  }

  findByArreteCadreId(
    acId: number,
    getZones: boolean = false,
  ): Promise<Departement[]> {
    const select: any = {
      id: true,
      code: true,
      nom: true,
    };
    if (getZones) {
      select.zonesAlerte = {
        id: true,
      };
    }
    const relations = getZones ? ['zonesAlerte'] : [];
    const where: any = {
      arretesCadre: {
        id: acId,
      },
    };
    if (getZones) {
      where.zonesAlerte = {
        disabled: false,
      };
    }
    return this.departementRepository.find({
      select,
      relations,
      where,
    });
  }

  @BusinessCron(CronExpression.EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT)
  async updateDepartementsGeom() {
    this.logger.log('MISE A JOUR DES DEPARTEMENTS');
    const sourceUrl =
      this.configService.get<string>('DEPARTEMENTS_GEOJSON_URL') ||
      DEFAULT_DEPARTEMENTS_GEOJSON_URL;
    const { data } = await firstValueFrom(this.httpService.get(sourceUrl));
    const toUpdate = parseDepartementGeometryFeed(data);
    await this.departementRepository.manager.transaction(async (manager) => {
      for (const departement of toUpdate) {
        const geometry = JSON.stringify(departement.geom);
        const [current] = await manager.query(
          `
            WITH incoming AS (
              SELECT ST_SetSRID(ST_GeomFromGeoJSON($2::text), 4326) AS geom
            )
            SELECT
              departement.id,
              CASE
                WHEN departement.geom IS NULL
                  OR ST_SRID(departement.geom) <> 4326
                THEN false
                ELSE ST_Equals(departement.geom, incoming.geom)
              END AS "matches"
            FROM departement
            CROSS JOIN incoming
            WHERE departement.code = $1
            FOR UPDATE OF departement
          `,
          [departement.code, geometry],
        );
        if (!current || current.matches === true) {
          continue;
        }

        await manager.query(
          `
            UPDATE departement
            SET geom = ST_SetSRID(ST_GeomFromGeoJSON($2::text), 4326)
            WHERE id = $1
          `,
          [current.id, geometry],
        );
      }
    });
    this.logger.log('DEPARTEMENTS MIS A JOUR');
  }
}
