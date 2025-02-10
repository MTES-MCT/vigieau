import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Departement } from './entities/departement.entity';
import { firstValueFrom } from 'rxjs';
import { ConfigService } from '@nestjs/config';
import { RegleauLogger } from '../logger/regleau.logger';
import { AbonnementMailService } from '../abonnement_mail/abonnement_mail.service';

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
    this.getAll();
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
      .leftJoin('departement.zonesAlerte', 'zonesAlerte')
      .leftJoin(
        'zonesAlerte.arretesCadre',
        'arretesCadre',
        'arretesCadre.statut IN (:...acStatut)',
        { acStatut: ['a_venir', 'publie'] },
      )
      .where('zonesAlerte.disabled = false')
      .orderBy('departement.code', 'ASC')
      .addOrderBy('zonesAlerte.code', 'ASC')
      .getMany();

    await Promise.all(this.departements.map(async d => {
      d.subscriptions = await this.abonnementMailService.getCountByDepartement(d.code);
      return d;
    }))
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

  @Cron(CronExpression.EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT)
  async updateDepartementsGeom() {
    this.logger.log('MISE A JOUR DES DEPARTEMENTS');
    const { data } = await firstValueFrom(
      this.httpService.get(
        'http://etalab-datasets.geo.data.gouv.fr/contours-administratifs/2023/geojson/departements-5m.geojson',
      ),
    );
    const toUpdate = data.features.map((feature) => {
      return {
        code: feature.properties.code,
        geom: feature.geometry,
      };
    });
    const sqlQueries = toUpdate.map((tmp) => {
      return this.departementRepository.update(
        {
          code: tmp.code,
        },
        {
          geom: tmp.geom,
        },
      );
    });
    await Promise.all(sqlQueries);
    await this.departementRepository.update(
      {},
      {
        geom: () => `ST_TRANSFORM(geom, 4326)`,
      },
    );
    this.logger.log('DEPARTEMENTS MIS A JOUR');
  }
}
