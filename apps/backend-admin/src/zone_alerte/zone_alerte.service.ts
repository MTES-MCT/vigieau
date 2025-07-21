import { HttpService } from '@nestjs/axios';
import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { User } from '@shared/entities/user.entity';
import { ZoneAlerte } from '@shared/entities/zone_alerte.entity';
import { firstValueFrom } from 'rxjs';
import {
  DataSource,
  FindManyOptions,
  FindOptionsWhere,
  In,
  IsNull,
  Not,
  Repository,
} from 'typeorm';
import { isMainThread } from 'worker_threads';
import { ArreteCadreService } from '../arrete_cadre/arrete_cadre.service';
import { BassinVersantService } from '../bassin_versant/bassin_versant.service';
import { DepartementService } from '../departement/departement.service';
import { RegleauLogger } from '../logger/regleau.logger';
import { MailService } from '../shared/services/mail.service';

@Injectable()
export class ZoneAlerteService {
  private readonly logger = new RegleauLogger('ZoneAlerteService');

  constructor(
    @InjectRepository(ZoneAlerte)
    private readonly zoneAlerteRepository: Repository<ZoneAlerte>,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly departementService: DepartementService,
    private readonly bassinVersantService: BassinVersantService,
    private readonly mailService: MailService,
    @Inject(forwardRef(() => ArreteCadreService))
    private readonly arreteCadreService: ArreteCadreService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async findOne(id: number, acIds?: number[]): Promise<any> {
    const za = await this.zoneAlerteRepository
      .createQueryBuilder('zone_alerte')
      .select('zone_alerte.id', 'id')
      .addSelect('zone_alerte.idSandre', 'idSandre')
      .addSelect('zone_alerte.code', 'code')
      .addSelect('zone_alerte.nom', 'nom')
      .addSelect('zone_alerte.type', 'type')
      .addSelect('zone_alerte.ressourceInfluencee', 'ressourceInfluencee')
      .addSelect('ST_AsGeoJSON(ST_TRANSFORM(zone_alerte.geom, 4326))', 'geom')
      .where('zone_alerte.id = :id', { id })
      .getRawOne();

    za.arreteCadreZoneAlerteCommunes = (
      await this.zoneAlerteRepository
        .createQueryBuilder('zone_alerte')
        .select(['zone_alerte.id'])
        .addSelect(['aczac.id', 'communes.id'])
        .leftJoin(
          'zone_alerte.arreteCadreZoneAlerteCommunes',
          'aczac',
          'aczac.arreteCadreId IN(:...acIds)',
          { acIds: acIds },
        )
        .leftJoin('aczac.communes', 'communes')
        .where('zone_alerte.id = :id', { id })
        .getOne()
    ).arreteCadreZoneAlerteCommunes;

    return za;
  }

  findByDepartement(departementCode: string): Promise<ZoneAlerte[]> {
    return this.zoneAlerteRepository.find(<FindManyOptions>{
      relations: ['departement'],
      where: {
        departement: {
          code: departementCode,
        },
        disabled: false,
      },
    });
  }

  findByArreteCadre(acId: number): Promise<ZoneAlerte[]> {
    return this.zoneAlerteRepository
      .createQueryBuilder('zone_alerte')
      .select('zone_alerte.id', 'id')
      .addSelect('zone_alerte.code', 'code')
      .addSelect('zone_alerte.nom', 'nom')
      .addSelect('zone_alerte.type', 'type')
      .addSelect(
        'ST_AsGeoJSON(ST_TRANSFORM(zone_alerte.geom, 4326), 3)',
        'geom',
      )
      .leftJoin('zone_alerte.arretesCadre', 'arrete_cadre')
      .where('arrete_cadre.id = :acId', { acId })
      .getRawMany();
  }

  findByArreteRestriction(arIds: number[]): Promise<ZoneAlerte[]> | any[] {
    if (!arIds || arIds.length < 1) {
      return [];
    }
    return this.zoneAlerteRepository.find(<FindManyOptions>{
      select: {
        id: true,
        idSandre: true,
        code: true,
        nom: true,
        type: true,
        ressourceInfluencee: true,
        departement: {
          code: true,
          nom: true,
        },
        restrictions: {
          niveauGravite: true,
          arreteRestriction: {
            id: true,
            numero: true,
            dateDebut: true,
            dateFin: true,
            dateSignature: true,
            fichier: {
              url: true,
            },
          },
          usages: {
            nom: true,
            concerneParticulier: true,
            concerneEntreprise: true,
            concerneExploitation: true,
            concerneCollectivite: true,
            concerneEso: true,
            concerneEsu: true,
            concerneAep: true,
            descriptionVigilance: true,
            descriptionAlerte: true,
            descriptionAlerteRenforcee: true,
            descriptionCrise: true,
            thematique: {
              nom: true,
            },
          },
        },
      },
      relations: [
        'departement',
        'restrictions',
        'restrictions.usages',
        'restrictions.usages.thematique',
        'restrictions.arreteRestriction',
        'restrictions.arreteRestriction.fichier',
      ],
      where: {
        restrictions: {
          arreteRestriction: {
            id: In(arIds),
          },
        },
      },
    });
  }

  async getMaxUpdatedDate(currentUser: User): Promise<string> {
    if (currentUser.role === 'commune') {
      return null;
    }

    const whereClause: FindOptionsWhere<ZoneAlerte> | null =
      !currentUser || currentUser.role === 'mte'
        ? {}
        : {
            departement: {
              code: In(currentUser.role_departements),
            },
          };

    const result = await this.zoneAlerteRepository
      .createQueryBuilder('zone_alerte')
      .select('MAX(zone_alerte.updatedAt)', 'maxDate')
      .leftJoin('zone_alerte.departement', 'departement')
      .where(whereClause)
      .getRawOne();
    return result?.maxDate || null;
  }

  /**
   * Vérification régulière s'il n'y a pas de nouvelles zones
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async updateZones() {
    if (!isMainThread) {
      return;
    }
    this.logger.log("MISE A JOUR DES ZONES D'ALERTE - DEBUT");
    const departements = await this.departementService.findAllLight();
    try {
      for (const d of departements) {
        let lastUpdate = (
          await this.zoneAlerteRepository
            .createQueryBuilder('zone_alerte')
            .select('MAX(zone_alerte.updatedAt)', 'updatedAt')
            .leftJoin('zone_alerte.departement', 'departement')
            .where('departement.id = :depId', { depId: d.id })
            .getRawOne()
        ).updatedAt;
        lastUpdate = lastUpdate ? lastUpdate.toISOString().split('T')[0] : null;
        const filterString = lastUpdate
          ? `Filter=<Filter>
<And>
<PropertyIsEqualTo><PropertyName>CdDepartement</PropertyName><Literal>${d.code}</Literal></PropertyIsEqualTo>
<PropertyIsGreaterThanOrEqualTo><PropertyName>DateMajZAS</PropertyName><Literal>${lastUpdate}</Literal></PropertyIsGreaterThanOrEqualTo>
</And>
</Filter>`
          : 'Filter=<Filter><PropertyIsEqualTo><PropertyName>CdDepartement</PropertyName><Literal>${d.code}</Literal></PropertyIsEqualTo></Filter>';
        const url = `${this.configService.get('API_SANDRE')}/geo/zas?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&typename=ZAS&SRSNAME=EPSG:4326&OUTPUTFORMAT=GeoJSON&${filterString}`;

        const { data } = await firstValueFrom(this.httpService.get(url));
        if (data.features?.length > 0) {
          await this.updateDepartementZones(d.code);
        }
      }
    } catch (error) {
      this.logger.error(
        "ERREUR LORS DE LA MISE A JOUR DES ZONES D'ALERTES",
        error,
      );
    }
    this.logger.log("MISE A JOUR DES ZONES D'ALERTE - FIN");
  }

  async updateDepartementZones(depCode: string) {
    this.logger.log(`MISE A JOUR DES ZONES D'ALERTE DU DEPARTEMENT ${depCode}`);
    const filterString = `Filter=<Filter>
<AND>
<PropertyIsEqualTo><PropertyName>CdDepartement</PropertyName><Literal>${depCode}</Literal></PropertyIsEqualTo>
<PropertyIsEqualTo><PropertyName>StZAS</PropertyName><Literal>Validé</Literal></PropertyIsEqualTo>
</AND>
</Filter>`;
    const url = `${this.configService.get('API_SANDRE')}/geo/zas?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&typename=ZAS&SRSNAME=EPSG:4326&OUTPUTFORMAT=GeoJSON&${filterString}`;
    let zonesUpdates = 0;
    let zonesAdded = 0;
    try {
      const { data } = await firstValueFrom(this.httpService.get(url));
      const idsSandre = data.features.map((f) => +f.properties.gid);
      const promises = [];
      for (const f of data.features) {
        let existingZone = await this.zoneAlerteRepository.findOne({
          where: [
            {
              idSandre: +f.properties.gid,
            },
            {
              idSandre: IsNull(),
              code: f.properties.CdAltZAS,
              departement: {
                code: depCode,
              },
              type: f.properties.TypeZAS,
              numeroVersion: f.properties.NumeroVersionZAS
                ? +f.properties.NumeroVersionZAS
                : IsNull(),
            },
          ],
        });
        if (!existingZone) {
          zonesAdded++;
          existingZone = new ZoneAlerte();
          existingZone.departement = await this.departementService.findByCode(
            f.properties.CdDepartement,
          );
          existingZone.bassinVersant =
            await this.bassinVersantService.findByCode(
              +f.properties.NumCircAdminBassin,
            );
        } else {
          zonesUpdates++;
        }
        existingZone.idSandre = +f.properties.gid;
        existingZone.nom = f.properties.LbZAS;
        existingZone.code = f.properties.CodesAlternatifs?.code ?? '';
        existingZone.type = f.properties.TypeZAS;
        existingZone.numeroVersionSandre = f.properties.NumeroVersionZAS
          ? +f.properties.NumeroVersionZAS
          : null;
        existingZone.geom = f.geometry;
        existingZone.ressourceInfluencee = f.properties.RessInfluenceeZAS === 1;
        existingZone.disabled = false;
        promises.push(this.zoneAlerteRepository.save(existingZone));
      }
      const idsToDisable = await this.zoneAlerteRepository.find(<
        FindManyOptions
      >{
        select: {
          id: true,
          idSandre: true,
          departement: {
            id: true,
            code: true,
          },
        },
        relations: ['departement'],
        where: [
          {
            departement: {
              code: depCode,
            },
            idSandre: Not(In(idsSandre)),
          },
          {
            departement: {
              code: depCode,
            },
            idSandre: IsNull(),
          },
        ],
      });
      promises.push(
        this.zoneAlerteRepository.update(
          idsToDisable.map((z) => z.id),
          { disabled: true },
        ),
      );
      await Promise.all(promises);
      this.logger.log(`${zonesUpdates} ZONES D'ALERTES MIS A JOUR`);
      this.logger.log(`${zonesAdded} ZONES D'ALERTES AJOUTEES`);
      if (zonesAdded > 0) {
        const arretesCadre =
          await this.arreteCadreService.findByDepartement(depCode);
        await this.mailService.sendEmailsByDepartement(
          depCode,
          `Vos nouvelles zones d’alerte ont été intégrées`,
          'maj_za',
          {
            arretesCadre: arretesCadre,
          },
          true,
        );
      }
    } catch (error) {
      this.logger.error(
        `ERREUR LORS DE LA MISE A JOUR DES ZONES D\'ALERTES DU DEPARTEMENT ${depCode}`,
        error,
      );
    }
  }

  async getZonesArea(zones: any[]) {
    return this.zoneAlerteRepository
      .createQueryBuilder('zone_alerte')
      .select(
        'SUM(ST_Area(ST_TRANSFORM(zone_alerte.geom, 4326)::geography)/1000000)',
        'area',
      )
      .where('zone_alerte.id IN(:...ids)', { ids: zones.map((z) => z.id) })
      .getRawOne();
  }

  getZonesIntersectedWithCommune(zones: ZoneAlerte[], communeId: number) {
    return (
      this.zoneAlerteRepository
        .createQueryBuilder('zone_alerte')
        .select('zone_alerte.id', 'id')
        .addSelect('zone_alerte.code', 'code')
        .addSelect('zone_alerte.nom', 'nom')
        .addSelect('zone_alerte.type', 'type')
        .where('zone_alerte.id IN(:...zonesId)', {
          zonesId: zones.map((z) => z.id),
        })
        .andWhere(
          `ST_GeometryType(zone_alerte.geom) IN ('ST_Polygon', 'ST_MultiPolygon')`,
        )
        .andWhere(
          'ST_INTERSECTS(ST_TRANSFORM(zone_alerte.geom, 4326), (SELECT ST_TRANSFORM(c.geom, 4326) FROM commune as c WHERE c.id = :communeId))',
          { communeId },
        )
        // Au moins 1% de la surface en commun
        .andWhere(
          'ST_Area(ST_Intersection(ST_TRANSFORM(zone_alerte.geom, 4326), (SELECT ST_TRANSFORM(c.geom, 4326) FROM commune as c WHERE c.id = :communeId))) / ST_Area((SELECT ST_TRANSFORM(c.geom, 4326) FROM commune as c WHERE c.id = :communeId)) > 0.01',
          { communeId },
        )
        .getRawMany()
    );
  }

  async getUnionGeomOfZoneAndCommunes(
    zoneId: number,
    communesId: number[],
  ): Promise<any> {
    const result = await this.dataSource.query(
      `
        SELECT ST_AsGeoJSON(ST_Union(zone.geom, communes.geom)) AS combined_geom
        FROM (
            SELECT ST_TRANSFORM(geom, 4326) AS geom
            FROM zone_alerte
            WHERE id = $1
        ) AS zone,
        (
            SELECT ST_Union(ST_TRANSFORM(geom, 4326)) AS geom
            FROM commune
            WHERE id = ANY($2)
        ) AS communes;
        `,
      [zoneId, communesId],
    );

    return result[0]?.combined_geom;
  }
}
