import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { RegleauLogger } from '../logger/regleau.logger';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { StatisticDepartement } from '@shared/entities/statistic_departement.entity';
import { CronExpression } from '@nestjs/schedule';
import { BusinessCron } from '../core/scheduling/business-cron';
import { Statistic } from '@shared/entities/statistic.entity';
import { DepartementService } from '../departement/departement.service';
import { User } from '@shared/entities/user.entity';
import { ZoneAlerteComputed } from '@shared/entities/zone_alerte_computed.entity';
import { ZoneAlerteComputedService } from '../zone_alerte_computed/zone_alerte_computed.service';
import { ZoneAlerteService } from '../zone_alerte/zone_alerte.service';
import { ZoneAlerteComputedHistoricService } from '../zone_alerte_computed/zone_alerte_computed_historic.service';
import { AbonnementMailService } from '../abonnement_mail/abonnement_mail.service';
import { shouldSkipStartupDataLoads } from '../core/startup-data-loads';

const ZONE_TYPES = ['SUP', 'SOU', 'AEP'] as const;
const GRAVITY_LEVELS = [
  'vigilance',
  'alerte',
  'alerte_renforcee',
  'crise',
] as const;

type ZoneType = (typeof ZONE_TYPES)[number];
type GravityLevel = (typeof GRAVITY_LEVELS)[number];
type RestrictionArea = number | string | undefined;
type RestrictionAreas = Record<GravityLevel, RestrictionArea>;

interface DepartementRestriction {
  date: string;
  SOU: RestrictionAreas;
  SUP: RestrictionAreas;
  AEP: RestrictionAreas;
}

interface ZoneAreaRequest {
  id: number;
  departementCode: string;
  zoneType: ZoneType;
  gravityLevel: GravityLevel;
}

interface ZoneAreaRow {
  departementCode: string;
  zoneType: ZoneType;
  gravityLevel: GravityLevel;
  area: number | null;
  requestedZoneCount: number | string;
  foundZoneCount: number | string;
}

@Injectable()
export class StatisticDepartementService {
  private readonly logger = new RegleauLogger('StatisticDepartementService');
  private statisticDepartements: StatisticDepartement[] = [];
  private statisticDepartementsLoading: Promise<void> | null = null;
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
    if (
      !shouldSkipStartupDataLoads() &&
      process.env.SKIP_STARTUP_DEPARTEMENT_STATISTICS !== 'true'
    ) {
      void this.loadStatDep();
    }
  }

  async findAll(currentUser: User): Promise<StatisticDepartement[]> {
    await this.ensureStatDepLoaded();
    if (!currentUser || currentUser.role === 'mte') {
      return this.statisticDepartements;
    } else {
      const userDepartementCodes = currentUser.role_departements || [];
      return this.statisticDepartements.filter((s) =>
        userDepartementCodes.includes(s.departement.code),
      );
    }
  }

  private async ensureStatDepLoaded() {
    if (this.statisticDepartements.length > 0) {
      return;
    }
    await this.loadStatDep();
  }

  async loadStatDep(force = false) {
    if (this.statisticDepartementsLoading && !force) {
      return this.statisticDepartementsLoading;
    }

    const loading = (async () => {
      this.statisticDepartements =
        await this.statisticDepartementRepository.find({
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
    })();

    this.statisticDepartementsLoading = loading;
    try {
      await loading;
    } finally {
      if (this.statisticDepartementsLoading === loading) {
        this.statisticDepartementsLoading = null;
      }
    }
  }

  @BusinessCron(CronExpression.EVERY_2_HOURS)
  async computeDepartementStatistics() {
    this.logger.log('Computing departement statistics...');
    const statsDepartement: StatisticDepartement[] =
      await this.statisticDepartementRepository.find({
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
        const depVisits = statByDay.departementRepartition
          ? statByDay.departementRepartition[d.code]
          : 0;
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

      statisticDepartement.subscriptions =
        await this.abonnementMailService.getCountByDepartement(d.code);

      this.logger.log(`Saving statistic departement for ${d.code}`);
      const statDepartement = statsDepartement.find(
        (s) => s.departement.id === d.id,
      );
      if (statDepartement) {
        await this.statisticDepartementRepository.update(
          { id: statDepartement.id },
          statisticDepartement,
        );
      } else {
        await this.statisticDepartementRepository.save(statisticDepartement);
      }
    }
    await this.loadStatDep(true);
  }

  async computeDepartementStatisticsRestrictions(
    zones: ZoneAlerteComputed[],
    date: Date,
    historic?: boolean,
    historicNotComputed?: boolean,
    departementCodes?: string[],
  ) {
    this.logger.log(
      `COMPUTING DEPARTEMENT STATISTICS RESTRICTIONS - ${date.toISOString().split('T')[0]}`,
    );
    const dateString = date.toISOString().split('T')[0];
    let departements = await this.departementService.findAllLight();
    if (departementCodes?.length) {
      const requestedCodes = new Set(departementCodes);
      departements = departements.filter((departement) =>
        requestedCodes.has(departement.code),
      );
    }
    const areaRequests = this.buildZoneAreaRequests(zones);
    const areaRows = await this.computeZoneAreas(
      areaRequests,
      historic,
      historicNotComputed,
    );
    const expectedAreaGroups = new Set(
      areaRequests.map((request) =>
        this.getZoneAreaKey(
          request.departementCode,
          request.zoneType,
          request.gravityLevel,
        ),
      ),
    );
    const areaByGroup = new Map<string, RestrictionArea>();
    for (const row of areaRows) {
      const key = this.getZoneAreaKey(
        row.departementCode,
        row.zoneType,
        row.gravityLevel,
      );
      if (
        !expectedAreaGroups.has(key) ||
        Number(row.requestedZoneCount) < 1 ||
        Number(row.foundZoneCount) !== Number(row.requestedZoneCount) ||
        row.area == null
      ) {
        throw new Error(`Zones statistiques departementales invalides: ${key}`);
      }
      areaByGroup.set(key, Number(row.area).toFixed(2));
    }
    if (areaByGroup.size !== expectedAreaGroups.size) {
      throw new Error(
        `Groupes statistiques departementaux incomplets: ${areaByGroup.size}/${expectedAreaGroups.size}`,
      );
    }

    const updates = departements.map((departement) => {
      const restriction = this.createEmptyRestriction(dateString);
      for (const zoneType of ZONE_TYPES) {
        for (const gravityLevel of GRAVITY_LEVELS) {
          const key = this.getZoneAreaKey(
            departement.code,
            zoneType,
            gravityLevel,
          );
          if (areaByGroup.has(key)) {
            restriction[zoneType][gravityLevel] = areaByGroup.get(key);
          }
        }
      }
      return {
        departementId: departement.id,
        date: dateString,
        restriction,
      };
    });
    if (updates.length === 0) {
      return;
    }

    const [result]: Array<{
      expected: number | string;
      affected: number | string;
    }> = await this.statisticDepartementRepository.query(
      `
          WITH updates AS MATERIALIZED (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS payload(
              "departementId" integer,
              "date" text,
              "restriction" jsonb
            )
          ), inserted AS (
            INSERT INTO "statistic_departement" (
              "departementId", "visits", "restrictions", "totalVisits",
              "weekVisits", "monthVisits", "yearVisits", "subscriptions"
            )
            SELECT DISTINCT
              updates."departementId", '[]'::jsonb,
              jsonb_build_array(updates."restriction"),
              0, 0, 0, 0, 0
            FROM updates
            ON CONFLICT ("departementId") DO NOTHING
            RETURNING "id", "departementId"
          ), current_values AS (
            SELECT
              statistic."id",
              statistic."restrictions",
              updates."date",
              updates."restriction"
            FROM "statistic_departement" statistic
            JOIN updates
              ON updates."departementId" = statistic."departementId"
          ), raw_merged_values AS (
            SELECT
              current_values."id",
              COALESCE(
                (
                  SELECT jsonb_agg(
                    CASE
                      WHEN item.value ->> 'date' = current_values."date"
                        THEN current_values."restriction"
                      ELSE item.value
                    END
                  )
                  FROM jsonb_array_elements(
                    COALESCE(current_values."restrictions", '[]'::jsonb)
                  ) AS item(value)
                ),
                '[]'::jsonb
              ) || CASE
                WHEN NOT EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(
                    COALESCE(current_values."restrictions", '[]'::jsonb)
                  ) AS item(value)
                  WHERE item.value ->> 'date' = current_values."date"
                )
                  THEN jsonb_build_array(current_values."restriction")
                ELSE '[]'::jsonb
              END AS "restrictions"
            FROM current_values
          ), merged_values AS (
            SELECT
              raw_merged_values."id",
              COALESCE(
                (
                  SELECT jsonb_agg(
                    item.value
                    ORDER BY
                      CASE
                        WHEN item.value ->> 'date'
                          ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN 0
                        ELSE 1
                      END,
                      CASE
                        WHEN item.value ->> 'date'
                          ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                          THEN item.value ->> 'date'
                        ELSE NULL
                      END,
                      item.ordinality
                  )
                  FROM jsonb_array_elements(
                    raw_merged_values."restrictions"
                  ) WITH ORDINALITY AS item(value, ordinality)
                ),
                '[]'::jsonb
              ) AS "restrictions"
            FROM raw_merged_values
          ), updated AS (
            UPDATE "statistic_departement" statistic
            SET "restrictions" = merged_values."restrictions"
            FROM merged_values
            WHERE statistic."id" = merged_values."id"
            RETURNING statistic."id"
          )
          SELECT
            (SELECT COUNT(*)::integer FROM updates) AS expected,
            (
              (SELECT COUNT(*)::integer FROM inserted)
              + (SELECT COUNT(*)::integer FROM updated)
            ) AS affected
        `,
      [JSON.stringify(updates)],
    );
    if (Number(result?.affected ?? 0) !== Number(result?.expected ?? 0)) {
      throw new Error(
        `Statistiques departementales incompletes: ${Number(result?.affected ?? 0)}/${Number(result?.expected ?? 0)} mises a jour`,
      );
    }
  }

  private buildZoneAreaRequests(
    zones: ZoneAlerteComputed[],
  ): ZoneAreaRequest[] {
    const requests = new Map<string, ZoneAreaRequest>();
    for (const zone of zones) {
      const zoneType = ZONE_TYPES.find((candidate) => candidate === zone.type);
      const gravityLevel = GRAVITY_LEVELS.find(
        (candidate) => candidate === zone.restriction?.niveauGravite,
      );
      if (!zoneType || !gravityLevel) {
        continue;
      }
      const request = {
        id: zone.id,
        departementCode: zone.departement.code,
        zoneType,
        gravityLevel,
      };
      requests.set(
        `${request.id}:${this.getZoneAreaKey(request.departementCode, zoneType, gravityLevel)}`,
        request,
      );
    }
    return [...requests.values()];
  }

  private async computeZoneAreas(
    requests: ZoneAreaRequest[],
    historic?: boolean,
    historicNotComputed?: boolean,
  ): Promise<ZoneAreaRow[]> {
    const source = historicNotComputed
      ? {
          table: 'zone_alerte',
          area: 'ST_Area(ST_TRANSFORM(zone.geom, 4326)::geography) / 1000000',
        }
      : historic
        ? {
            table: 'zone_alerte_computed_historic',
            area: 'ST_Area(zone.geom::geography) / 1000000',
          }
        : {
            table: 'zone_alerte_computed',
            area: 'ST_Area(zone.geom::geography) / 1000000',
          };

    return this.statisticDepartementRepository.query(
      `
        WITH requested_zones AS (
          SELECT DISTINCT
            request."id",
            request."departementCode",
            request."zoneType",
            request."gravityLevel"
          FROM jsonb_to_recordset($1::jsonb) AS request(
            "id" integer,
            "departementCode" text,
            "zoneType" text,
            "gravityLevel" text
          )
        )
        SELECT
          requested."departementCode" AS "departementCode",
          requested."zoneType" AS "zoneType",
          requested."gravityLevel" AS "gravityLevel",
          SUM(${source.area}) AS "area",
          COUNT(*)::integer AS "requestedZoneCount",
          COUNT(zone."id")::integer AS "foundZoneCount"
        FROM requested_zones requested
        LEFT JOIN "${source.table}" zone ON zone."id" = requested."id"
        GROUP BY
          requested."departementCode",
          requested."zoneType",
          requested."gravityLevel"
        ORDER BY
          requested."departementCode",
          requested."zoneType",
          requested."gravityLevel"
      `,
      [JSON.stringify(requests)],
    );
  }

  private createEmptyRestriction(date: string): DepartementRestriction {
    const emptyAreas = (): RestrictionAreas => ({
      vigilance: 0,
      alerte: 0,
      alerte_renforcee: 0,
      crise: 0,
    });
    return {
      date,
      SOU: emptyAreas(),
      SUP: emptyAreas(),
      AEP: emptyAreas(),
    };
  }

  private getZoneAreaKey(
    departementCode: string,
    zoneType: ZoneType,
    gravityLevel: GravityLevel,
  ): string {
    return `${departementCode}:${zoneType}:${gravityLevel}`;
  }

  async sortStatDepartement() {
    this.logger.log(`SORTING DEPARTEMENT STATISTICS RESTRICTIONS`);
    const qb = this.statisticDepartementRepository
      .createQueryBuilder('statistic_departement')
      .update()
      .set({
        restrictions: () => `
          (
            SELECT jsonb_agg(
              item.value
              ORDER BY
                CASE
                  WHEN item.value ->> 'date'
                    ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN 0
                  ELSE 1
                END,
                CASE
                  WHEN item.value ->> 'date'
                    ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                    THEN item.value ->> 'date'
                  ELSE NULL
                END,
                item.ordinality
            )
            FROM jsonb_array_elements(restrictions)
              WITH ORDINALITY AS item(value, ordinality)
          )`,
      })
      .where(`"restrictions" is not null`);
    await qb.execute();
    return;
  }
}
