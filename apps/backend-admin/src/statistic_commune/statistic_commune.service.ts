import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, Repository } from 'typeorm';
import { StatisticCommune } from './entities/statistic_commune.entity';
import { ZoneAlerteComputed } from '../zone_alerte_computed/entities/zone_alerte_computed.entity';
import { RegleauLogger } from '../logger/regleau.logger';
import { CommuneService } from '../commune/commune.service';
import { ZoneAlerteComputedService } from '../zone_alerte_computed/zone_alerte_computed.service';
import { ZoneAlerteService } from '../zone_alerte/zone_alerte.service';
import { Commune } from '../commune/entities/commune.entity';
import { Utils } from '../core/utils';
import moment from 'moment/moment';
import { ZoneAlerteComputedHistoricService } from '../zone_alerte_computed/zone_alerte_computed_historic.service';
import { Moment } from 'moment';

@Injectable()
export class StatisticCommuneService {
  private readonly logger = new RegleauLogger('StatisticCommuneService');

  constructor(
    @InjectRepository(StatisticCommune)
    private readonly statisticCommuneRepository: Repository<StatisticCommune>,
    private readonly communeService: CommuneService,
    @Inject(forwardRef(() => ZoneAlerteComputedService))
    private readonly zoneAlerteComputedService: ZoneAlerteComputedService,
    @Inject(forwardRef(() => ZoneAlerteComputedHistoricService))
    private readonly zoneAlerteComputedHistoricService: ZoneAlerteComputedHistoricService,
    private readonly zoneAlerteService: ZoneAlerteService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {
    // setTimeout(() => {
    //   this.computeByMonth();
    // }, 5000);
  }

  async getStatisticCommuneStream() {
    return this.statisticCommuneRepository.createQueryBuilder('sc')
      .leftJoinAndSelect('sc.commune', 'commune')
      .stream();
  }

  async computeCommuneStatisticsRestrictions(zones: ZoneAlerteComputed[], date: Date, historic?: boolean, historicNotComputed?: boolean) {
    const dateString = date.toISOString().split('T')[0];
    this.logger.log(`COMPUTING COMMUNE STATISTICS RESTRICTIONS - ${dateString}`);

    const batchSize = 1000;
    const communeSize = await this.communeService.count();
    for (let i = 0; i < communeSize; i += batchSize) {
      this.logger.log(`BATCH ${i}`);
      const communes = await this.communeService.findWithStats(batchSize, i);

      await Promise.all(communes.map(async (c: Commune) => {
        let statCommune = c.statisticCommune;
        if (!statCommune) {
          // @ts-ignore
          statCommune = {
            commune: c,
            restrictions: [],
          };
          statCommune = await this.statisticCommuneRepository.save(statCommune);
        }

        const restriction = {
          date: date.toISOString().split('T')[0],
          SOU: null,
          SUP: null,
          AEP: null,
        };
        const zonesDep = zones.filter(z => z.departement.code === c.departement.code);
        let zonesCommune;
        if (!historicNotComputed) {
          zonesCommune = zonesDep.length > 0 ? historic ?
            await this.zoneAlerteComputedHistoricService.getZonesIntersectedWithCommune(zonesDep, c.id) :
            await this.zoneAlerteComputedService.getZonesIntersectedWithCommune(zonesDep, c.id) : [];
        } else {
          zonesCommune = zonesDep.length > 0 ? await this.zoneAlerteService.getZonesIntersectedWithCommune(<any>zonesDep, c.id) : [];
        }
        zonesCommune = zonesDep.filter(z => zonesCommune.some(zc => zc.id === z.id));
        const zonesType = ['SUP', 'SOU', 'AEP'];
        const niveauxGravite = ['vigilance', 'alerte', 'alerte_renforcee', 'crise'];

        zonesType.forEach(zoneType => {
          const zonesCommuneType = zonesCommune.filter(z => z.type === zoneType);

          niveauxGravite.forEach(niveauGravite => {
            if (zonesCommuneType.some(z => z.restriction?.niveauGravite === niveauGravite)) {
              restriction[zoneType] = niveauGravite;
            }
          });
        });

        const qb =
          this.statisticCommuneRepository.createQueryBuilder('statistic_commune')
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
            .where('id = :id', { id: statCommune.id });
        await qb.execute();
        return;
      }));
    }
  }

  async computeByMonth(date?: Moment) {
    this.logger.log('COMPUTE BY MONTH');

    const dateDebut = date ? date : moment('01/01/2013', 'DD/MM/YYYY');
    const dateFin = moment();

    for (let m = moment(dateDebut); m.diff(dateFin, 'days') <= 0; m.add(1, 'month')) {
      this.logger.log(`COMPUTE STAT BY MONTH ${m.format('YYYY-MM')}`);
      await this.computeCommuneStatisticsRestrictionsByMonth(m.toDate());
    }
  }

  async computeCommuneStatisticsRestrictionsByMonth(date: Date) {
    const dateMoment = moment(date);

    const batchSize = 1000;
    const communeSize = await this.communeService.count();
    for (let i = 0; i < communeSize; i += batchSize) {
      this.logger.log(`BATCH ${i}`);
      const communes = await this.communeService.findWithStats(batchSize, i);

      await Promise.all(communes.map(async (c: Commune) => {
        let statCommune = c.statisticCommune;
        if (!statCommune) {
          return;
        }

        const restrictionByMonth = {
          date: dateMoment.format('YYYY-MM'),
          ponderation: 0,
        };
        const allRestrictionsByMonth = (await this.dataSource.query(`
        SELECT  r
FROM  statistic_commune sc, jsonb_array_elements(sc.restrictions) r
where id = ${statCommune.id} and to_char((r->>'date')::date, 'YYYY-MM') = '${dateMoment.format('YYYY-MM')}';
        `)).map(r => r.r);
        for (const restriction of allRestrictionsByMonth) {
          const niveauGraviteMax = [
            Utils.getNiveau(restriction.AEP),
            Utils.getNiveau(restriction.SOU),
            Utils.getNiveau(restriction.SUP),
          ]
            .reduce((prev, current) => {
              return prev > current ? prev : current;
            });

          restrictionByMonth.ponderation += this.getPonderation(niveauGraviteMax);
        }

        const qb =
          this.statisticCommuneRepository.createQueryBuilder('statistic_commune')
            .update()
            .set({
              restrictionsByMonth: () => `
              (
        SELECT jsonb_agg(
            CASE
                -- Si l'élément "date" est égal à la date du jour, on le remplace
                WHEN r ->> 'date' = '${dateMoment.format('YYYY-MM')}' THEN '${JSON.stringify(restrictionByMonth)}'::jsonb
                -- Sinon, on conserve l'élément tel quel
                ELSE r
            END
        )
        FROM jsonb_array_elements(restrictionsByMonth) as r
        -- Si aucun élément avec "date": date du jour n'existe, on ajoute le nouvel élément à la fin
    ) || CASE 
            WHEN NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements(restrictionsByMonth) as r
                WHERE r ->> 'date' = '${dateMoment.format('YYYY-MM')}'
            )
            THEN '[${JSON.stringify(restrictionByMonth)}]'::jsonb
            ELSE '[]'::jsonb
        END
              `,
            })
            .where('id = :id', { id: statCommune.id });
        await qb.execute();
        return;
      }));
    }
  }

  async sortStatCommune() {
    this.logger.log(`SORTING COMMUNE STATISTICS RESTRICTIONS`);
    const qb =
      this.statisticCommuneRepository.createQueryBuilder('statistic_commune')
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


    const qbBis =
      this.statisticCommuneRepository.createQueryBuilder('statistic_commune')
        .update()
        .set({
          restrictionsByMonth: () => `
              (
        SELECT jsonb_agg(r)
    FROM (
      SELECT r
      FROM jsonb_array_elements(restrictionsByMonth) AS r
      ORDER BY TO_DATE((r->>'date'), 'YYYY-MM')
    ) as sorted
              )`,
        })
        .where(`"restrictionsByMonth" is not null`);
    await qbBis.execute();
    return;
  }

  getPonderation(niveauGravite) {
    switch (niveauGravite) {
      case 2:
        return 0.5;
      case 3:
        return 2;
      case 4:
        return 3;
      case 5:
        return 4;
      default:
        return 0;
    }
  }
}
