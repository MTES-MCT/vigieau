import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { RegleauLogger } from '../logger/regleau.logger';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, MoreThanOrEqual, Repository } from 'typeorm';
import { StatisticDepartement } from '@shared/entities/statistic_departement.entity';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Statistic } from '@shared/entities/statistic.entity';
import { DepartementService } from '../departement/departement.service';
import { User } from '@shared/entities/user.entity';
import { ZoneAlerteComputed } from '@shared/entities/zone_alerte_computed.entity';
import { ZoneAlerteComputedService } from '../zone_alerte_computed/zone_alerte_computed.service';
import { ZoneAlerteService } from '../zone_alerte/zone_alerte.service';
import { ZoneAlerteComputedHistoricService } from '../zone_alerte_computed/zone_alerte_computed_historic.service';
import { AbonnementMailService } from '../abonnement_mail/abonnement_mail.service';

@Injectable()
export class StatisticDepartementService {
  private readonly logger = new RegleauLogger('StatisticDepartementService');
  private statisticDepartements: StatisticDepartement[] = [];
  releaseDate = '2023-07-12';

  constructor(
    @InjectRepository(StatisticDepartement)
    private readonly statisticDepartementRepository: Repository<StatisticDepartement>,
    @InjectRepository(Statistic)
    private readonly statisticRepository: Repository<Statistic>,
    private readonly abonnementMailService: AbonnementMailService,
    private readonly departementService: DepartementService,
    @Inject(forwardRef(() => ZoneAlerteComputedService))
    private readonly zoneAlerteComputedService: ZoneAlerteComputedService,
    @Inject(forwardRef(() => ZoneAlerteComputedHistoricService))
    private readonly zoneAlerteComputedHistoricService: ZoneAlerteComputedHistoricService,
    private readonly zoneAlerteService: ZoneAlerteService,
  ) {
    this.loadStatDep();
    setTimeout(() => {
        this.computeDepartementStatistics();
      }, 5000,
    );
  }

  findAll(currentUser: User): StatisticDepartement[] {
    if (!currentUser || currentUser.role === 'mte') {
      return this.statisticDepartements;
    } else {
      return this.statisticDepartements.filter(s => currentUser.role_departements.includes(s.departement.code));
    }
  }

  async loadStatDep() {
    this.statisticDepartements = await this.statisticDepartementRepository.find({
      select: {
        id: true,
        visits: true,
        totalVisits: true,
        weekVisits: true,
        monthVisits: true,
        yearVisits: true,
        subscriptions: true,
        departement: {
          id: true,
          code: true,
          nom: true,
        },
      },
      relations: ['departement'],
    });
  }

  @Cron(CronExpression.EVERY_2_HOURS)
  async computeDepartementStatistics() {
    this.logger.log('Computing departement statistics...');
    const statsDepartement: StatisticDepartement[] = await this.statisticDepartementRepository.find({
      select: {
        id: true,
        departement: {
          id: true,
          code: true,
        },
      },
      relations: ['departement'],
    });
    const stats: Statistic[] = await this.statisticRepository.find({
      where: {
        date: MoreThanOrEqual(this.releaseDate),
      },
      order: {
        date: 'ASC',
      },
    });

    const departements = await this.departementService.findAllLight();

    for (const d of departements) {
      const statisticDepartement = {
        departement: d,
        visits: [],
        totalVisits: 0,
        weekVisits: 0,
        monthVisits: 0,
        yearVisits: 0,
        subscriptions: 0,
      };

      for (const statByDay of stats) {
        const depVisits = statByDay.departementRepartition ? statByDay.departementRepartition[d.code] : 0;
        statisticDepartement.totalVisits += depVisits;
        statisticDepartement.visits.push({
          date: statByDay.date,
          visits: depVisits,
        });

        const today = new Date();
        const date = new Date(statByDay.date);
        const diffInTime = today.getTime() - date.getTime();
        const diffInDays = Math.round(diffInTime / (1000 * 3600 * 24));

        if (diffInDays <= 7) {
          statisticDepartement.weekVisits += depVisits;
        }
        if (diffInDays <= 30) {
          statisticDepartement.monthVisits += depVisits;
        }
        if (diffInDays <= 365) {
          statisticDepartement.yearVisits += depVisits;
        }
      }

      statisticDepartement.subscriptions = await this.abonnementMailService.getCountByDepartement(d.code);

      this.logger.log(`Saving statistic departement for ${d.code}`);
      const statDepartement = statsDepartement.find(s => s.departement.id === d.id);
      if (statDepartement) {
        await this.statisticDepartementRepository.update({ id: statDepartement.id }, statisticDepartement);
      } else {
        await this.statisticDepartementRepository.save(statisticDepartement);
      }
    }
    this.loadStatDep();
  }

  async computeDepartementStatisticsRestrictions(zones: ZoneAlerteComputed[], date: Date, historic?: boolean, historicNotComputed?: boolean) {
    this.logger.log(`COMPUTING DEPARTEMENT STATISTICS RESTRICTIONS - ${date.toISOString().split('T')[0]}`);
    const statsDepartement: StatisticDepartement[] = await this.statisticDepartementRepository.find({
      select: {
        id: true,
        departement: {
          id: true,
          code: true,
        },
      },
      relations: ['departement'],
    });
    const dateString = date.toISOString().split('T')[0];
    const departements = await this.departementService.findAllLight();

    await Promise.all(departements.map(async d => {
      let statDepartement = statsDepartement.find(s => s.departement.code === d.code);
      if (!statDepartement) {
        // @ts-ignore
        statDepartement = {
          departement: d,
          visits: [],
          totalVisits: 0,
          weekVisits: 0,
          monthVisits: 0,
          yearVisits: 0,
          subscriptions: 0,
          restrictions: [],
        };
        statDepartement = await this.statisticDepartementRepository.save(statDepartement);
      }

      const restriction = {
        date: dateString,
        SOU: {
          vigilance: 0,
          alerte: 0,
          alerte_renforcee: 0,
          crise: 0,
        },
        SUP: {
          vigilance: 0,
          alerte: 0,
          alerte_renforcee: 0,
          crise: 0,
        },
        AEP: {
          vigilance: 0,
          alerte: 0,
          alerte_renforcee: 0,
          crise: 0,
        },
      };
      const zonesDep = zones.filter(z => z.departement.code === d.code);
      const zonesType = ['SUP', 'SOU', 'AEP'];
      const niveauxGravite = ['vigilance', 'alerte', 'alerte_renforcee', 'crise'];
      for (let i = 0; i < zonesType.length; i++) {
        const type = zonesType[i];
        const zonesDepType = zonesDep.filter(z => z.type === type);
        for (let j = 0; j < niveauxGravite.length; j++) {
          const niveauGravite = niveauxGravite[j];
          const zonesDepTypeNiveauGravite = zonesDepType.filter(z => z.restriction?.niveauGravite === niveauGravite);
          if(!historicNotComputed) {
            restriction[type][niveauGravite] = zonesDepTypeNiveauGravite.length > 0 ?
              historic ? (await this.zoneAlerteComputedHistoricService.getZonesArea(zonesDepTypeNiveauGravite)).area?.toFixed(2) :
                (await this.zoneAlerteComputedService.getZonesArea(zonesDepTypeNiveauGravite)).area?.toFixed(2) : 0;
          } else {
            restriction[type][niveauGravite] = zonesDepTypeNiveauGravite.length > 0 ?
              (await this.zoneAlerteService.getZonesArea(zonesDepTypeNiveauGravite)).area?.toFixed(2) : 0;
          }
        }
      }

      const qb =
        this.statisticDepartementRepository.createQueryBuilder('statistic_departement')
          .update()
          .set({
            restrictions: () => `
              (
        SELECT jsonb_agg(
            CASE
                -- Si l'élément "date" est égal à la date du jour, on le remplace
                WHEN r ->> 'date' = '${dateString}' THEN '${JSON.stringify(restriction)}'::jsonb
                -- Sinon, on conserve l'élément tel quel
                ELSE r
            END
        )
        FROM jsonb_array_elements(restrictions) as r
        -- Si aucun élément avec "date": date du jour n'existe, on ajoute le nouvel élément à la fin
    ) || CASE 
            WHEN NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements(restrictions) as r
                WHERE r ->> 'date' = '${dateString}'
            )
            THEN '[${JSON.stringify(restriction)}]'::jsonb
            ELSE '[]'::jsonb
        END
              `,
          })
          .where('id = :id', { id: statDepartement.id });
      await qb.execute();
      return;
    }));
  }

  async sortStatDepartement() {
    this.logger.log(`SORTING DEPARTEMENT STATISTICS RESTRICTIONS`);
    const qb =
      this.statisticDepartementRepository.createQueryBuilder('statistic_departement')
        .update()
        .set({
          restrictions: () => `
              (
        SELECT jsonb_agg(r)
    FROM (
      SELECT r
      FROM jsonb_array_elements(restrictions) AS r
      ORDER BY (r->>'date')::date
    ) as sorted
              )`,
        })
        .where(`"restrictions" is not null`);
    await qb.execute();
    return;
  }
}