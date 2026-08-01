import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryRunner, Repository } from 'typeorm';
import { StatisticCommune } from '@shared/entities/statistic_commune.entity';
import { ZoneAlerteComputed } from '@shared/entities/zone_alerte_computed.entity';
import { RegleauLogger } from '../logger/regleau.logger';
import { CommuneService } from '../commune/commune.service';
import { ZoneAlerteComputedService } from '../zone_alerte_computed/zone_alerte_computed.service';
import { ZoneAlerteService } from '../zone_alerte/zone_alerte.service';
import { Commune } from '@shared/entities/commune.entity';
import { Utils } from '../core/utils';
import moment from 'moment/moment';
import { ZoneAlerteComputedHistoricService } from '../zone_alerte_computed/zone_alerte_computed_historic.service';
import { Moment } from 'moment';

const STATISTIC_COMMUNE_SNAPSHOT_LOCK =
  'vigieau:statistic-commune:snapshot-computation';

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
    await this.assertNoIncompleteSnapshots();
    return this.statisticCommuneRepository
      .createQueryBuilder('sc')
      .innerJoin('sc.commune', 'commune')
      .select('commune.code', 'commune_code')
      .addSelect('commune.nom', 'commune_nom')
      .addSelect('sc.restrictions', 'sc_restrictions')
      .where(
        `NOT EXISTS (
          SELECT 1
          FROM statistic_commune_snapshot snapshot
          WHERE snapshot.status <> 'completed'
        )`,
      )
      .orderBy('commune.code', 'ASC')
      .stream();
  }

  async getStatisticCommuneStreamForYear(year: number) {
    if (!Number.isInteger(year) || year < 2013 || year > 9999) {
      throw new Error(`Invalid statistic year: ${year}`);
    }

    const startDate = `${year}-01-01`;
    const endDate = `${year + 1}-01-01`;
    await this.assertNoIncompleteSnapshots(startDate, endDate);

    return this.statisticCommuneRepository
      .createQueryBuilder('sc')
      .innerJoin('sc.commune', 'commune')
      .select('commune.code', 'commune_code')
      .addSelect('commune.nom', 'commune_nom')
      .addSelect(
        `COALESCE(
          (
            SELECT jsonb_agg(restriction.value ORDER BY restriction.value ->> 'date')
            FROM jsonb_array_elements(COALESCE(sc.restrictions, '[]'::jsonb)) AS restriction(value)
            WHERE restriction.value ->> 'date' >= :startDate
              AND restriction.value ->> 'date' < :endDate
          ),
          '[]'::jsonb
        )`,
        'sc_restrictions',
      )
      .setParameters({ startDate, endDate })
      .where(
        `NOT EXISTS (
          SELECT 1
          FROM statistic_commune_snapshot snapshot
          WHERE snapshot.status <> 'completed'
            AND (
              snapshot.scope = 'bootstrap'
              OR (
                snapshot."snapshotDate" >= :startDate
                AND snapshot."snapshotDate" < :endDate
              )
            )
        )`,
      )
      .orderBy('commune.code', 'ASC')
      .stream();
  }

  async computeCommuneStatisticsRestrictions(
    zones: ZoneAlerteComputed[],
    date: Date,
    historic?: boolean,
    historicNotComputed?: boolean,
    departementCodes?: string[],
  ) {
    const dateString = date.toISOString().split('T')[0];
    this.logger.log(
      `COMPUTING COMMUNE STATISTICS RESTRICTIONS - ${dateString}`,
    );

    const queryRunner = this.dataSource.createQueryRunner();
    let connected = false;
    let locked = false;
    let snapshotStarted = false;
    let processedCommuneCount = 0;
    const snapshotScope = this.getSnapshotScope(departementCodes);
    let nationalSnapshotAlreadyCompleted = false;

    try {
      await queryRunner.connect();
      connected = true;
      const [lock] = await queryRunner.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [STATISTIC_COMMUNE_SNAPSHOT_LOCK],
      );
      locked = lock?.locked === true;
      if (!locked) {
        throw new Error(
          'Un calcul des statistiques communales est deja en cours',
        );
      }

      if (snapshotScope !== 'national') {
        nationalSnapshotAlreadyCompleted =
          await this.hasCompletedNationalSnapshot(queryRunner, dateString);
      }

      const batchSize = 1000;
      const communeSize = await this.communeService.count(departementCodes);
      await this.markSnapshotRunning(
        queryRunner,
        dateString,
        snapshotScope,
        communeSize,
      );
      snapshotStarted = true;
      if (communeSize === 0) {
        throw new Error('Aucune commune a calculer pour le snapshot');
      }

      for (let i = 0; i < communeSize; i += batchSize) {
        this.logger.log(`BATCH ${i}`);
        const communes = await this.communeService.findWithStats(
          batchSize,
          i,
          departementCodes,
        );

        await Promise.all(
          communes.map(async (c: Commune) => {
            let statCommune = c.statisticCommune;
            if (!statCommune) {
              statCommune = await this.statisticCommuneRepository.save({
                commune: c,
                restrictions: [],
              } as StatisticCommune);
            }

            const restriction = {
              date: date.toISOString().split('T')[0],
              SOU: null,
              SUP: null,
              AEP: null,
            };
            const zonesDep = zones.filter(
              (z) => z.departement.code === c.departement.code,
            );
            let zonesCommune;
            if (!historicNotComputed) {
              zonesCommune =
                zonesDep.length > 0
                  ? historic
                    ? await this.zoneAlerteComputedHistoricService.getZonesIntersectedWithCommune(
                        zonesDep,
                        c.id,
                      )
                    : await this.zoneAlerteComputedService.getZonesIntersectedWithCommune(
                        zonesDep,
                        c.id,
                      )
                  : [];
            } else {
              zonesCommune =
                zonesDep.length > 0
                  ? await this.zoneAlerteService.getZonesIntersectedWithCommune(
                      <any>zonesDep,
                      c.id,
                    )
                  : [];
            }
            zonesCommune = zonesDep.filter((z) =>
              zonesCommune.some((zc) => zc.id === z.id),
            );
            const zonesType = ['SUP', 'SOU', 'AEP'];
            const niveauxGravite = [
              'vigilance',
              'alerte',
              'alerte_renforcee',
              'crise',
            ];

            zonesType.forEach((zoneType) => {
              const zonesCommuneType = zonesCommune.filter(
                (z) => z.type === zoneType,
              );

              niveauxGravite.forEach((niveauGravite) => {
                if (
                  zonesCommuneType.some(
                    (z) => z.restriction?.niveauGravite === niveauGravite,
                  )
                ) {
                  restriction[zoneType] = niveauGravite;
                }
              });
            });

            const qb = this.statisticCommuneRepository
              .createQueryBuilder('statistic_commune')
              .update()
              .set({
                restrictions: () => `
              COALESCE((
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
    ), '[]'::jsonb) || CASE
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
            const updateResult = await qb.execute();
            if (updateResult.affected !== 1) {
              throw new Error(
                `La statistique de la commune ${c.id} n'a pas ete mise a jour`,
              );
            }
            return;
          }),
        );
        processedCommuneCount += communes.length;
        await this.markSnapshotProgress(
          queryRunner,
          dateString,
          snapshotScope,
          processedCommuneCount,
        );
      }

      const finalCommuneSize =
        await this.communeService.count(departementCodes);
      if (processedCommuneCount !== finalCommuneSize) {
        throw new Error(
          `Snapshot communal incomplet: ${processedCommuneCount}/${finalCommuneSize} communes calculees`,
        );
      }
      await this.markSnapshotCompleted(
        queryRunner,
        dateString,
        snapshotScope,
        processedCommuneCount,
        nationalSnapshotAlreadyCompleted,
      );
    } catch (error) {
      if (snapshotStarted) {
        await this.markSnapshotFailed(
          queryRunner,
          dateString,
          snapshotScope,
          processedCommuneCount,
          error,
        );
      }
      throw error;
    } finally {
      if (locked) {
        try {
          await queryRunner.query(
            'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
            [STATISTIC_COMMUNE_SNAPSHOT_LOCK],
          );
        } catch (error) {
          this.logger.error(
            'ERREUR LORS DE LA LIBERATION DU VERROU DES STATISTIQUES COMMUNALES',
            error,
          );
        }
      }
      if (connected) {
        try {
          await queryRunner.release();
        } catch (error) {
          this.logger.error(
            'ERREUR LORS DE LA LIBERATION DE LA CONNEXION DES STATISTIQUES COMMUNALES',
            error,
          );
        }
      }
    }
  }

  private async assertNoIncompleteSnapshots(
    startDate?: string,
    endDate?: string,
  ): Promise<void> {
    const parameters: string[] = [];
    const dateFilter =
      startDate && endDate
        ? `AND (
            "scope" = 'bootstrap'
            OR ("snapshotDate" >= $1 AND "snapshotDate" < $2)
          )`
        : '';
    if (startDate && endDate) {
      parameters.push(startDate, endDate);
    }
    const [snapshot] = await this.dataSource.query(
      `
        SELECT "snapshotDate", "scope", "status", "processedCommuneCount", "expectedCommuneCount"
        FROM "statistic_commune_snapshot"
        WHERE "status" <> 'completed'
        ${dateFilter}
        ORDER BY "snapshotDate" ASC
        LIMIT 1
      `,
      parameters,
    );
    if (snapshot) {
      const snapshotDate =
        snapshot.snapshotDate instanceof Date
          ? snapshot.snapshotDate.toISOString().slice(0, 10)
          : String(snapshot.snapshotDate).slice(0, 10);
      throw new Error(
        `Snapshot communal ${snapshotDate} non publie (${snapshot.scope}, ${snapshot.status}, ${Number(snapshot.processedCommuneCount)}/${Number(snapshot.expectedCommuneCount)})`,
      );
    }
  }

  private getSnapshotScope(departementCodes?: string[]): string {
    if (!departementCodes?.length) {
      return 'national';
    }
    return `departements:${[...new Set(departementCodes)].sort().join(',')}`;
  }

  private async hasCompletedNationalSnapshot(
    queryRunner: QueryRunner,
    snapshotDate: string,
  ): Promise<boolean> {
    const [snapshot] = await queryRunner.query(
      `
        SELECT 1
        FROM "statistic_commune_snapshot"
        WHERE "snapshotDate" = $1
          AND "scope" = 'national'
          AND "status" = 'completed'
      `,
      [snapshotDate],
    );
    return Boolean(snapshot);
  }

  private async markSnapshotRunning(
    queryRunner: QueryRunner,
    snapshotDate: string,
    snapshotScope: string,
    expectedCommuneCount: number,
  ): Promise<void> {
    await queryRunner.query(
      `
        INSERT INTO "statistic_commune_snapshot" (
          "snapshotDate", "scope", "status", "expectedCommuneCount",
          "processedCommuneCount", "startedAt", "completedAt", "lastError",
          "createdAt", "updatedAt"
        ) VALUES ($1, $2, 'running', $3, 0, now(), NULL, NULL, now(), now())
        ON CONFLICT ("snapshotDate", "scope") DO UPDATE SET
          "status" = 'running',
          "expectedCommuneCount" = EXCLUDED."expectedCommuneCount",
          "processedCommuneCount" = 0,
          "startedAt" = now(),
          "completedAt" = NULL,
          "lastError" = NULL,
          "updatedAt" = now()
      `,
      [snapshotDate, snapshotScope, expectedCommuneCount],
    );
  }

  private async markSnapshotProgress(
    queryRunner: QueryRunner,
    snapshotDate: string,
    snapshotScope: string,
    processedCommuneCount: number,
  ): Promise<void> {
    await queryRunner.query(
      `
        UPDATE "statistic_commune_snapshot"
        SET "processedCommuneCount" = $3, "updatedAt" = now()
        WHERE "snapshotDate" = $1
          AND "scope" = $2
          AND "status" = 'running'
      `,
      [snapshotDate, snapshotScope, processedCommuneCount],
    );
  }

  private async markSnapshotCompleted(
    queryRunner: QueryRunner,
    snapshotDate: string,
    snapshotScope: string,
    processedCommuneCount: number,
    nationalSnapshotAlreadyCompleted: boolean,
  ): Promise<void> {
    const completedStatus =
      snapshotScope === 'national' || nationalSnapshotAlreadyCompleted
        ? 'completed'
        : 'partial';
    const [result] = await queryRunner.query(
      `
        WITH completed_snapshot AS (
          UPDATE "statistic_commune_snapshot"
          SET "status" = $3,
              "processedCommuneCount" = $4,
              "completedAt" = now(),
              "lastError" = NULL,
              "updatedAt" = now()
          WHERE "snapshotDate" = $1
            AND "scope" = $2
            AND "status" = 'running'
            AND "expectedCommuneCount" = $4
          RETURNING 1
        )
        SELECT COUNT(*)::integer AS affected FROM completed_snapshot
      `,
      [snapshotDate, snapshotScope, completedStatus, processedCommuneCount],
    );
    if (Number(result?.affected ?? 0) !== 1) {
      throw new Error(
        `Le snapshot communal ${snapshotDate} ne couvre pas toutes les communes attendues`,
      );
    }
    if (snapshotScope === 'national') {
      await queryRunner.query(
        `
          UPDATE "statistic_commune_snapshot"
          SET "status" = 'completed',
              "completedAt" = now(),
              "lastError" = NULL,
              "updatedAt" = now()
          WHERE "snapshotDate" = $1
        `,
        [snapshotDate],
      );
      await queryRunner.query(
        `
          DELETE FROM "statistic_commune_snapshot"
          WHERE "scope" = 'bootstrap'
        `,
      );
    }
  }

  private async markSnapshotFailed(
    queryRunner: QueryRunner,
    snapshotDate: string,
    snapshotScope: string,
    processedCommuneCount: number,
    error: unknown,
  ): Promise<void> {
    try {
      await queryRunner.query(
        `
          UPDATE "statistic_commune_snapshot"
          SET "status" = 'failed',
              "processedCommuneCount" = $3,
              "completedAt" = NULL,
              "lastError" = $4,
              "updatedAt" = now()
          WHERE "snapshotDate" = $1
            AND "scope" = $2
        `,
        [
          snapshotDate,
          snapshotScope,
          processedCommuneCount,
          error instanceof Error ? error.message : String(error),
        ],
      );
    } catch (snapshotError) {
      this.logger.error(
        "ERREUR LORS DE L'ENREGISTREMENT DE L'ECHEC DU SNAPSHOT COMMUNAL",
        snapshotError,
      );
    }
  }

  async computeByMonth(date?: Moment, departementCodes?: string[]) {
    this.logger.log('COMPUTE BY MONTH');

    const dateDebut = date ? date : moment('01/01/2013', 'DD/MM/YYYY');
    const dateFin = moment();

    for (
      let m = moment(dateDebut);
      m.diff(dateFin, 'days') <= 0;
      m.add(1, 'month')
    ) {
      this.logger.log(`COMPUTE STAT BY MONTH ${m.format('YYYY-MM')}`);
      await this.computeCommuneStatisticsRestrictionsByMonth(
        m.toDate(),
        departementCodes,
      );
    }
  }

  async computeCommuneStatisticsRestrictionsByMonth(
    date: Date,
    departementCodes?: string[],
  ) {
    const dateMoment = moment(date);

    const batchSize = 1000;
    const communeSize = await this.communeService.count(departementCodes);
    for (let i = 0; i < communeSize; i += batchSize) {
      this.logger.log(`BATCH ${i}`);
      const communes = await this.communeService.findWithStats(
        batchSize,
        i,
        departementCodes,
      );

      await Promise.all(
        communes.map(async (c: Commune) => {
          const statCommune = c.statisticCommune;
          if (!statCommune) {
            return;
          }

          const restrictionByMonth = {
            date: dateMoment.format('YYYY-MM'),
            ponderation: 0,
          };
          const allRestrictionsByMonth = (
            await this.dataSource.query(`
        SELECT  r
FROM  statistic_commune sc, jsonb_array_elements(sc.restrictions) r
where id = ${statCommune.id} and to_char((r->>'date')::date, 'YYYY-MM') = '${dateMoment.format('YYYY-MM')}';
        `)
          ).map((r) => r.r);
          for (const restriction of allRestrictionsByMonth) {
            const niveauGraviteMax = [
              Utils.getNiveau(restriction.AEP),
              Utils.getNiveau(restriction.SOU),
              Utils.getNiveau(restriction.SUP),
            ].reduce((prev, current) => {
              return prev > current ? prev : current;
            });

            restrictionByMonth.ponderation +=
              this.getPonderation(niveauGraviteMax);
          }

          const qb = this.statisticCommuneRepository
            .createQueryBuilder('statistic_commune')
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
        }),
      );
    }
  }

  async sortStatCommune(departementCodes?: string[]) {
    this.logger.log(`SORTING COMMUNE STATISTICS RESTRICTIONS`);
    const qb = this.statisticCommuneRepository
      .createQueryBuilder('statistic_commune')
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
    if (departementCodes?.length > 0) {
      qb.andWhere(
        `"communeId" IN (
          SELECT commune.id
          FROM commune
          JOIN departement ON departement.id = commune."departementId"
          WHERE departement.code IN (:...departementCodes)
        )`,
        { departementCodes },
      );
    }
    await qb.execute();

    const qbBis = this.statisticCommuneRepository
      .createQueryBuilder('statistic_commune')
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
    if (departementCodes?.length > 0) {
      qbBis.andWhere(
        `"communeId" IN (
          SELECT commune.id
          FROM commune
          JOIN departement ON departement.id = commune."departementId"
          WHERE departement.code IN (:...departementCodes)
        )`,
        { departementCodes },
      );
    }
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
