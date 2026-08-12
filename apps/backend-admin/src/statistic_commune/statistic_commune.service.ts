import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryRunner, Repository } from 'typeorm';
import { StatisticCommune } from '@shared/entities/statistic_commune.entity';
import { ZoneAlerteComputed } from '@shared/entities/zone_alerte_computed.entity';
import { RegleauLogger } from '../logger/regleau.logger';
import { CommuneService } from '../commune/commune.service';
// Moment still exposes a CommonJS callable export under the current Jest/NodeNext setup.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import moment = require('moment');
import { Moment } from 'moment';

const STATISTIC_COMMUNE_SNAPSHOT_LOCK =
  'vigieau:statistic-commune:snapshot-computation';
const DEFAULT_COMMUNE_STATISTICS_BATCH_SIZE = 250;
const MAX_COMMUNE_STATISTICS_BATCH_SIZE = 1000;
export const HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS_DEFAULT = 7;
const HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS_LIMIT = 31;
const STATISTIC_ZONE_TYPES = ['SUP', 'SOU', 'AEP'] as const;
const STATISTIC_SEVERITIES = [
  'vigilance',
  'alerte',
  'alerte_renforcee',
  'crise',
] as const;

type StatisticSeverity = (typeof STATISTIC_SEVERITIES)[number];

export function parseCommuneStatisticsBatchSize(
  value: string | undefined,
): number {
  if (value === undefined) {
    return DEFAULT_COMMUNE_STATISTICS_BATCH_SIZE;
  }

  const normalizedValue = value.trim();
  if (!/^\d+$/.test(normalizedValue)) {
    throw new Error(
      `Invalid COMMUNE_STATISTICS_BATCH_SIZE: ${value} (expected an integer between 1 and ${MAX_COMMUNE_STATISTICS_BATCH_SIZE})`,
    );
  }

  const batchSize = Number(normalizedValue);
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_COMMUNE_STATISTICS_BATCH_SIZE
  ) {
    throw new Error(
      `Invalid COMMUNE_STATISTICS_BATCH_SIZE: ${value} (expected an integer between 1 and ${MAX_COMMUNE_STATISTICS_BATCH_SIZE})`,
    );
  }

  return batchSize;
}

export function parseHistoricEmptyStatisticsRangeMaxDays(
  value = process.env.HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS,
): number {
  if (value === undefined || value.trim() === '') {
    return HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS_DEFAULT;
  }
  const normalizedValue = value.trim();
  if (!/^[1-9]\d*$/.test(normalizedValue)) {
    throw new Error(
      'Invalid HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS: expected a positive integer',
    );
  }
  const maxDays = Number(normalizedValue);
  if (
    !Number.isSafeInteger(maxDays) ||
    maxDays > HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS_LIMIT
  ) {
    throw new Error(
      `Invalid HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS: expected at most ${HISTORIC_EMPTY_STATISTICS_RANGE_MAX_DAYS_LIMIT}`,
    );
  }
  return maxDays;
}

interface CommuneStatisticRestriction {
  date: string;
  SOU: StatisticSeverity | null;
  SUP: StatisticSeverity | null;
  AEP: StatisticSeverity | null;
}

interface StatisticZoneInput {
  id: number;
  departementCode: string;
}

interface CommuneZoneIntersection {
  communeId: number | string;
  zoneId: number | string | null;
}

interface StatisticSnapshotHooks {
  beforeCommuneStatistics?: () => Promise<void>;
  beforeCertification?: () => Promise<void>;
  deferCertificationUntilPublication?: boolean;
  preserveBootstrapBarrier?: boolean;
  requireNationalCoverage?: boolean;
  publishCurrentDate?: boolean;
  sourceRevision?: string;
  historicComputeEpoch?: string;
}

interface StatisticSnapshotCertificationOptions {
  requireNationalCoverage?: boolean;
  publishCurrentDate?: boolean;
}

export interface EmptyHistoricStatisticDay {
  date: Date;
  beforeCommuneStatistics?: () => Promise<void>;
  beforeCertification?: () => Promise<void>;
}

export interface EmptyHistoricStatisticRangeOptions {
  sourceRevision: string;
  historicComputeEpoch: string;
}

interface MonthlyStatisticComputationOptions {
  aggregateThrough?: Moment;
  allowedReadySnapshot?: {
    date: string;
    sourceRevision: string;
  };
}

@Injectable()
export class StatisticCommuneService {
  private readonly logger = new RegleauLogger('StatisticCommuneService');

  constructor(
    @InjectRepository(StatisticCommune)
    private readonly statisticCommuneRepository: Repository<StatisticCommune>,
    private readonly communeService: CommuneService,
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
            WHERE restriction.value ->> 'date' >= :startDate::text
              AND restriction.value ->> 'date' < :endDate::text
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
                snapshot."snapshotDate" >= :startDate::date
                AND snapshot."snapshotDate" < :endDate::date
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
    hooks?: StatisticSnapshotHooks,
  ) {
    const batchSize = parseCommuneStatisticsBatchSize(
      process.env.COMMUNE_STATISTICS_BATCH_SIZE,
    );
    const dateString = date.toISOString().split('T')[0];
    this.logger.log(
      `COMPUTING COMMUNE STATISTICS RESTRICTIONS - ${dateString}`,
    );

    const queryRunner = this.dataSource.createQueryRunner();
    let connected = false;
    let locked = false;
    let snapshotStarted = false;
    let statisticZoneGeometryPrepared = false;
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

      const communeSize = await this.communeService.count(departementCodes);
      await this.markSnapshotRunning(
        queryRunner,
        dateString,
        snapshotScope,
        communeSize,
        hooks?.sourceRevision,
      );
      snapshotStarted = true;
      if (communeSize === 0) {
        throw new Error('Aucune commune a calculer pour le snapshot');
      }

      const { zoneInputs, zonesById } = this.prepareStatisticZones(
        zones,
        dateString,
      );
      if (zoneInputs.length > 0) {
        statisticZoneGeometryPrepared = true;
        await this.prepareStatisticZoneGeometryTable(
          queryRunner,
          zoneInputs,
          Boolean(historic),
          Boolean(historicNotComputed),
        );
      }

      await hooks?.beforeCommuneStatistics?.();

      for (let i = 0; i < communeSize; i += batchSize) {
        this.logger.log(`BATCH ${i}`);
        const communes = await this.communeService.findWithStats(
          batchSize,
          i,
          departementCodes,
        );
        if (communes.length === 0) {
          throw new Error(
            `Lot communal vide a partir de ${i} pour ${communeSize} communes attendues`,
          );
        }

        const intersections = await this.findCommuneZoneIntersections(
          queryRunner,
          communes.map((commune) => commune.id),
          Boolean(historicNotComputed),
          zoneInputs.length > 0,
        );

        const zoneIdsByCommune = new Map<number, Set<number>>();
        for (const intersection of intersections) {
          const communeId = Number(intersection.communeId);
          if (intersection.zoneId === null) {
            throw new Error(
              `Geometrie communale invalide pour la commune ${communeId} le ${dateString}`,
            );
          }
          const zoneId = Number(intersection.zoneId);
          if (!Number.isInteger(communeId) || !Number.isInteger(zoneId)) {
            throw new Error(
              `Intersection communale invalide pour le ${dateString}`,
            );
          }
          const zoneIds = zoneIdsByCommune.get(communeId) ?? new Set<number>();
          zoneIds.add(zoneId);
          zoneIdsByCommune.set(communeId, zoneIds);
        }

        const restrictions = communes.map((commune) => ({
          communeId: commune.id,
          restriction: this.buildCommuneStatisticRestriction(
            dateString,
            zoneIdsByCommune.get(commune.id) ?? new Set<number>(),
            zonesById,
          ),
        }));
        const nextProcessedCommuneCount =
          processedCommuneCount + communes.length;
        await this.persistCommuneStatisticsBatch(
          queryRunner,
          restrictions,
          dateString,
          snapshotScope,
          nextProcessedCommuneCount,
        );
        processedCommuneCount = nextProcessedCommuneCount;
      }

      const finalCommuneSize =
        await this.communeService.count(departementCodes);
      if (processedCommuneCount !== finalCommuneSize) {
        throw new Error(
          `Snapshot communal incomplet: ${processedCommuneCount}/${finalCommuneSize} communes calculees`,
        );
      }
      await hooks?.beforeCertification?.();
      await this.markSnapshotCompleted(
        queryRunner,
        dateString,
        snapshotScope,
        processedCommuneCount,
        nationalSnapshotAlreadyCompleted,
        hooks?.deferCertificationUntilPublication === true,
        hooks?.preserveBootstrapBarrier === true,
        hooks?.sourceRevision,
        hooks?.historicComputeEpoch,
        {
          requireNationalCoverage: hooks?.requireNationalCoverage === true,
          publishCurrentDate: hooks?.publishCurrentDate === true,
        },
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
      if (statisticZoneGeometryPrepared) {
        try {
          await queryRunner.query(
            'DROP TABLE IF EXISTS pg_temp."statistic_zone_geometry"',
          );
        } catch (error) {
          this.logger.error(
            'ERREUR LORS DU NETTOYAGE DES GEOMETRIES STATISTIQUES TEMPORAIRES',
            error,
          );
        }
      }
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

  async computeEmptyHistoricCommuneStatisticsRange(
    days: EmptyHistoricStatisticDay[],
    options: EmptyHistoricStatisticRangeOptions,
  ): Promise<void> {
    const maxDays = parseHistoricEmptyStatisticsRangeMaxDays();
    const dateStrings = this.validateEmptyHistoricStatisticRange(
      days,
      maxDays,
      options,
    );
    const batchSize = parseCommuneStatisticsBatchSize(
      process.env.COMMUNE_STATISTICS_BATCH_SIZE,
    );
    const queryRunner = this.dataSource.createQueryRunner();
    let connected = false;
    let locked = false;
    let snapshotsStarted = false;
    let processedCommuneCount = 0;

    this.logger.log(
      `COMPUTING EMPTY COMMUNE STATISTICS RANGE - ${dateStrings[0]}..${dateStrings[dateStrings.length - 1]}`,
    );

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

      const communeSize = await this.communeService.count();
      if (communeSize === 0) {
        throw new Error('Aucune commune a calculer pour les snapshots vides');
      }
      await this.markEmptyHistoricSnapshotsRunning(
        queryRunner,
        dateStrings,
        communeSize,
        options,
      );
      snapshotsStarted = true;

      for (const day of days) {
        await this.assertEmptyHistoricRangeContext(queryRunner, options);
        await day.beforeCommuneStatistics?.();
        await this.assertEmptyHistoricRangeContext(queryRunner, options);
      }

      for (let offset = 0; offset < communeSize; offset += batchSize) {
        this.logger.log(`EMPTY RANGE BATCH ${offset}`);
        const communes = await this.communeService.findWithStats(
          batchSize,
          offset,
        );
        if (communes.length === 0) {
          throw new Error(
            `Lot communal vide a partir de ${offset} pour ${communeSize} communes attendues`,
          );
        }
        const nextProcessedCommuneCount =
          processedCommuneCount + communes.length;
        await this.persistEmptyHistoricCommuneStatisticsBatch(
          queryRunner,
          communes.map((commune) => commune.id),
          dateStrings,
          communeSize,
          nextProcessedCommuneCount,
          options,
        );
        processedCommuneCount = nextProcessedCommuneCount;
      }

      const finalCommuneSize = await this.communeService.count();
      if (
        processedCommuneCount !== finalCommuneSize ||
        finalCommuneSize !== communeSize
      ) {
        throw new Error(
          `Snapshots communaux vides incomplets: ${processedCommuneCount}/${finalCommuneSize} communes calculees, ${communeSize} attendues`,
        );
      }

      for (let index = 0; index < days.length; index += 1) {
        await this.assertEmptyHistoricRangeContext(queryRunner, options);
        await days[index].beforeCertification?.();
        await this.assertEmptyHistoricRangeContext(queryRunner, options);
        await this.markEmptyHistoricSnapshotCompleted(
          queryRunner,
          dateStrings[index],
          processedCommuneCount,
          options,
        );
      }
    } catch (error) {
      if (snapshotsStarted) {
        await this.markEmptyHistoricSnapshotsFailed(
          queryRunner,
          dateStrings,
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

  private validateEmptyHistoricStatisticRange(
    days: EmptyHistoricStatisticDay[],
    maxDays: number,
    options: EmptyHistoricStatisticRangeOptions,
  ): string[] {
    if (days.length === 0 || days.length > maxDays) {
      throw new Error(
        `Invalid empty historic statistic range length: ${days.length}/${maxDays}`,
      );
    }
    if (
      !/^\d+$/.test(options.sourceRevision) ||
      !/^\d+$/.test(options.historicComputeEpoch)
    ) {
      throw new Error('Invalid empty historic statistic range context');
    }
    const dateStrings = days.map((day) => {
      if (!(day.date instanceof Date) || Number.isNaN(day.date.getTime())) {
        throw new Error('Invalid empty historic statistic date');
      }
      return day.date.toISOString().slice(0, 10);
    });
    for (let index = 1; index < dateStrings.length; index += 1) {
      const expected = moment
        .utc(dateStrings[index - 1], 'YYYY-MM-DD', true)
        .add(1, 'day')
        .format('YYYY-MM-DD');
      if (dateStrings[index] !== expected) {
        throw new Error(
          `Empty historic statistic range is not contiguous: ${dateStrings[index - 1]} -> ${dateStrings[index]}`,
        );
      }
    }
    return dateStrings;
  }

  private prepareStatisticZones(
    zones: ZoneAlerteComputed[],
    dateString: string,
  ): {
    zoneInputs: StatisticZoneInput[];
    zonesById: Map<number, ZoneAlerteComputed>;
  } {
    const zonesById = new Map<number, ZoneAlerteComputed>();
    const zoneInputs: StatisticZoneInput[] = [];
    for (const zone of zones) {
      if (!Number.isInteger(zone.id)) {
        throw new Error(`Zone sans identifiant pour le ${dateString}`);
      }
      if (!zone.departement?.code) {
        throw new Error(
          `Zone ${zone.id} sans departement pour le ${dateString}`,
        );
      }
      if (zonesById.has(zone.id)) {
        continue;
      }
      zonesById.set(zone.id, zone);
      zoneInputs.push({
        id: zone.id,
        departementCode: zone.departement.code,
      });
    }
    return { zoneInputs, zonesById };
  }

  private async findCommuneZoneIntersections(
    queryRunner: QueryRunner,
    communeIds: number[],
    historicNotComputed: boolean,
    hasZones: boolean,
  ): Promise<CommuneZoneIntersection[]> {
    if (!hasZones || communeIds.length === 0) {
      return [];
    }

    const rawCommuneGeometry = historicNotComputed
      ? 'ST_TRANSFORM(commune.geom, 4326)'
      : 'commune.geom';
    const validGeometry = (geometry: string) => `
      CASE
        WHEN ST_IsValid(${geometry}, 0) THEN ${geometry}
        ELSE ST_CollectionExtract(
          ST_MakeValid(${geometry}, 'method=structure keepcollapsed=false'),
          3
        )
      END`;

    return queryRunner.query(
      `
        WITH raw_communes AS MATERIALIZED (
          SELECT
            commune.id,
            departement.code AS "departementCode",
            ${rawCommuneGeometry} AS geom
          FROM commune
          JOIN departement ON departement.id = commune."departementId"
          WHERE commune.id = ANY($1::integer[])
        ), normalized_communes AS MATERIALIZED (
          SELECT
            raw_communes.id,
            raw_communes."departementCode",
            ${validGeometry('raw_communes.geom')} AS geom
          FROM raw_communes
        ), valid_communes AS MATERIALIZED (
          SELECT *
          FROM normalized_communes
          WHERE geom IS NOT NULL
            AND NOT ST_IsEmpty(geom)
            AND ST_GeometryType(geom) IN ('ST_Polygon', 'ST_MultiPolygon')
            AND ST_IsValid(geom, 0)
        )
        SELECT
          valid_communes.id AS "communeId",
          valid_zones.id AS "zoneId"
        FROM valid_communes
        JOIN pg_temp."statistic_zone_geometry" valid_zones
          ON valid_zones."departementCode" = valid_communes."departementCode"
         AND ST_Intersects(valid_zones.geom, valid_communes.geom)
        WHERE
          ST_Area(ST_Intersection(valid_zones.geom, valid_communes.geom))
          / NULLIF(ST_Area(valid_communes.geom), 0) > 0.01
        UNION ALL
        SELECT
          normalized_communes.id AS "communeId",
          NULL::integer AS "zoneId"
        FROM normalized_communes
        WHERE normalized_communes.geom IS NULL
          OR ST_IsEmpty(normalized_communes.geom)
          OR ST_GeometryType(normalized_communes.geom)
            NOT IN ('ST_Polygon', 'ST_MultiPolygon')
          OR NOT ST_IsValid(normalized_communes.geom, 0)
      `,
      [communeIds],
    );
  }

  private async prepareStatisticZoneGeometryTable(
    queryRunner: QueryRunner,
    zones: StatisticZoneInput[],
    historic: boolean,
    historicNotComputed: boolean,
  ): Promise<void> {
    const table = historicNotComputed
      ? 'zone_alerte'
      : historic
        ? 'zone_alerte_computed_historic'
        : 'zone_alerte_computed';
    const rawGeometry = historicNotComputed
      ? 'ST_Transform(source_zone.geom, 4326)'
      : 'source_zone.geom';

    await queryRunner.query(
      'DROP TABLE IF EXISTS pg_temp."statistic_zone_geometry"',
    );
    await queryRunner.query(
      `
        CREATE TEMP TABLE "statistic_zone_geometry"
        ON COMMIT PRESERVE ROWS AS
        WITH zone_input AS (
          SELECT *
          FROM jsonb_to_recordset($1::jsonb)
            AS input(id integer, "departementCode" text)
        ), transformed AS MATERIALIZED (
          SELECT
            zone_input.id,
            zone_input."departementCode",
            ${rawGeometry} AS geom
          FROM zone_input
          LEFT JOIN "${table}" source_zone ON source_zone.id = zone_input.id
        )
        SELECT
          transformed.id,
          transformed."departementCode",
          CASE
            WHEN ST_IsValid(transformed.geom, 0) THEN transformed.geom
            ELSE ST_CollectionExtract(
              ST_MakeValid(
                transformed.geom,
                'method=structure keepcollapsed=false'
              ),
              3
            )
          END AS geom
        FROM transformed
      `,
      [JSON.stringify(zones)],
    );
    const [validation] = await queryRunner.query(
      `
        SELECT
          COUNT(*)::integer AS "loadedCount",
          COALESCE(
            array_agg(id ORDER BY id) FILTER (
              WHERE geom IS NULL
                OR ST_IsEmpty(geom)
                OR ST_GeometryType(geom) NOT IN ('ST_Polygon', 'ST_MultiPolygon')
                OR NOT ST_IsValid(geom, 0)
            ),
            ARRAY[]::integer[]
          ) AS "invalidIds"
        FROM pg_temp."statistic_zone_geometry"
      `,
    );
    const invalidIds = (validation?.invalidIds ?? []).map(Number);
    if (
      Number(validation?.loadedCount ?? 0) !== zones.length ||
      invalidIds.length > 0
    ) {
      throw new Error(
        `Geometries de zones statistiques invalides: ${invalidIds.join(',') || 'nombre de zones incoherent'}`,
      );
    }
  }

  private buildCommuneStatisticRestriction(
    dateString: string,
    zoneIds: Set<number>,
    zonesById: Map<number, ZoneAlerteComputed>,
  ): CommuneStatisticRestriction {
    const restriction: CommuneStatisticRestriction = {
      date: dateString,
      SOU: null,
      SUP: null,
      AEP: null,
    };
    const intersectedZones = [...zoneIds]
      .map((zoneId) => zonesById.get(zoneId))
      .filter((zone): zone is ZoneAlerteComputed => Boolean(zone));

    for (const zoneType of STATISTIC_ZONE_TYPES) {
      for (const severity of STATISTIC_SEVERITIES) {
        if (
          intersectedZones.some(
            (zone) =>
              zone.type === zoneType &&
              zone.restriction?.niveauGravite === severity,
          )
        ) {
          restriction[zoneType] = severity;
        }
      }
    }
    return restriction;
  }

  private async persistCommuneStatisticsBatch(
    queryRunner: QueryRunner,
    restrictions: Array<{
      communeId: number;
      restriction: CommuneStatisticRestriction;
    }>,
    dateString: string,
    snapshotScope: string,
    processedCommuneCount: number,
  ): Promise<void> {
    let transactionStarted = false;
    try {
      await queryRunner.startTransaction();
      transactionStarted = true;
      const payload = JSON.stringify(restrictions);
      await queryRunner.query(
        `
          INSERT INTO "statistic_commune" ("communeId", "restrictions")
          SELECT input."communeId", '[]'::jsonb
          FROM jsonb_to_recordset($1::jsonb)
            AS input("communeId" integer, restriction jsonb)
          ON CONFLICT ("communeId") DO NOTHING
        `,
        [payload],
      );
      const [updateResult] = await queryRunner.query(
        `
          WITH input AS MATERIALIZED (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb)
              AS value("communeId" integer, restriction jsonb)
          ), matched AS MATERIALIZED (
            SELECT
              statistic.id,
              statistic."restrictions",
              input.restriction,
              existing."dateCount",
              existing."identicalCount",
              existing."firstDateOrdinality"
            FROM input
            JOIN "statistic_commune" statistic
              ON statistic."communeId" = input."communeId"
            CROSS JOIN LATERAL (
              SELECT
                COUNT(*) FILTER (
                  WHERE item.value ->> 'date' = $2
                )::integer AS "dateCount",
                COUNT(*) FILTER (
                  WHERE item.value ->> 'date' = $2
                    AND item.value = input.restriction
                )::integer AS "identicalCount",
                MIN(item.ordinality) FILTER (
                  WHERE item.value ->> 'date' = $2
                ) AS "firstDateOrdinality"
              FROM jsonb_array_elements(
                COALESCE(statistic."restrictions", '[]'::jsonb)
              ) WITH ORDINALITY AS item(value, ordinality)
            ) existing
          ), candidate AS MATERIALIZED (
            SELECT
              matched.id,
              normalized."nextRestrictions"
            FROM matched
            CROSS JOIN LATERAL (
              SELECT COALESCE(
                jsonb_agg(
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
                    item.phase,
                    item.ordinality
                ),
                '[]'::jsonb
              ) AS "nextRestrictions"
              FROM (
                SELECT
                  CASE
                    WHEN existing.ordinality = matched."firstDateOrdinality"
                      THEN matched.restriction
                    ELSE existing.value
                  END AS value,
                  0 AS phase,
                  existing.ordinality
                FROM jsonb_array_elements(
                  COALESCE(matched."restrictions", '[]'::jsonb)
                ) WITH ORDINALITY AS existing(value, ordinality)
                WHERE existing.value ->> 'date' IS DISTINCT FROM $2
                  OR existing.ordinality = matched."firstDateOrdinality"
                UNION ALL
                SELECT
                  matched.restriction,
                  1 AS phase,
                  1::bigint AS ordinality
                WHERE matched."dateCount" = 0
              ) item
            ) normalized
            WHERE NOT (
              matched."dateCount" = 1
              AND matched."identicalCount" = 1
            )
          ), updated AS (
            UPDATE "statistic_commune" statistic
            SET "restrictions" = candidate."nextRestrictions"
            FROM candidate
            WHERE statistic.id = candidate.id
            RETURNING statistic.id
          )
          SELECT
            (SELECT COUNT(*)::integer FROM matched) AS matched,
            (SELECT COUNT(*)::integer FROM updated) AS updated,
            (
              SELECT COUNT(*)::integer
              FROM matched
              WHERE matched."dateCount" = 1
                AND matched."identicalCount" = 1
            ) AS unchanged
        `,
        [payload, dateString],
      );
      const matchedCount = Number(updateResult?.matched ?? 0);
      if (matchedCount !== restrictions.length) {
        throw new Error(
          `Lot communal incomplet: ${matchedCount}/${restrictions.length} statistiques trouvees`,
        );
      }
      const updatedCount = Number(updateResult?.updated ?? 0);
      const unchangedCount = Number(updateResult?.unchanged ?? 0);
      if (updatedCount + unchangedCount !== restrictions.length) {
        throw new Error(
          `Lot communal incomplet: ${updatedCount} mises a jour + ${unchangedCount} inchangees / ${restrictions.length} statistiques attendues`,
        );
      }
      await this.markSnapshotProgress(
        queryRunner,
        dateString,
        snapshotScope,
        processedCommuneCount,
      );
      await queryRunner.commitTransaction();
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          await queryRunner.rollbackTransaction();
        } catch (rollbackError) {
          this.logger.error(
            "ERREUR LORS DE L'ANNULATION DU LOT DE STATISTIQUES COMMUNALES",
            rollbackError,
          );
        }
      }
      throw error;
    }
  }

  private async markEmptyHistoricSnapshotsRunning(
    queryRunner: QueryRunner,
    dateStrings: string[],
    expectedCommuneCount: number,
    options: EmptyHistoricStatisticRangeOptions,
  ): Promise<void> {
    const [result] = await queryRunner.query(
      `
        WITH current_context AS MATERIALIZED (
          SELECT 1
          FROM "config" config
          CROSS JOIN "zone_publication_source_state" source_state
          WHERE config."id" = 1
            AND config."historicComputeEpoch" = $4::bigint
            AND source_state."id" = 1
            AND source_state."revision" = $3::bigint
        ), target_dates AS MATERIALIZED (
          SELECT unnest($1::date[]) AS "snapshotDate"
        ), started AS (
          INSERT INTO "statistic_commune_snapshot" (
            "snapshotDate", "scope", "status", "expectedCommuneCount",
            "processedCommuneCount", "startedAt", "completedAt", "lastError",
            "sourceRevision", "createdAt", "updatedAt"
          )
          SELECT
            target_dates."snapshotDate", 'national', 'running', $2, 0,
            now(), NULL, NULL, $3::bigint, now(), now()
          FROM target_dates
          CROSS JOIN current_context
          ON CONFLICT ("snapshotDate", "scope") DO UPDATE SET
            "status" = 'running',
            "expectedCommuneCount" = EXCLUDED."expectedCommuneCount",
            "processedCommuneCount" = 0,
            "startedAt" = now(),
            "completedAt" = NULL,
            "lastError" = NULL,
            "sourceRevision" = EXCLUDED."sourceRevision",
            "updatedAt" = now()
          RETURNING 1
        )
        SELECT
          EXISTS(SELECT 1 FROM current_context) AS "contextMatches",
          (SELECT COUNT(*)::integer FROM started) AS affected
      `,
      [
        dateStrings,
        expectedCommuneCount,
        options.sourceRevision,
        options.historicComputeEpoch,
      ],
    );
    if (
      result?.contextMatches !== true ||
      Number(result?.affected ?? 0) !== dateStrings.length
    ) {
      throw new Error(
        `Unable to start empty historic statistic range ${dateStrings[0]}..${dateStrings[dateStrings.length - 1]} in the expected context`,
      );
    }
  }

  private async assertEmptyHistoricRangeContext(
    queryRunner: QueryRunner,
    options: EmptyHistoricStatisticRangeOptions,
  ): Promise<void> {
    const rows = await queryRunner.query(
      `
        SELECT 1
        FROM "config" config
        CROSS JOIN "zone_publication_source_state" source_state
        WHERE config."id" = 1
          AND config."historicComputeEpoch" = $1::bigint
          AND source_state."id" = 1
          AND source_state."revision" = $2::bigint
        FOR SHARE OF config, source_state
      `,
      [options.historicComputeEpoch, options.sourceRevision],
    );
    if (rows.length !== 1) {
      throw new Error(
        `Empty historic statistic range context changed (epoch=${options.historicComputeEpoch}, sourceRevision=${options.sourceRevision})`,
      );
    }
  }

  private async persistEmptyHistoricCommuneStatisticsBatch(
    queryRunner: QueryRunner,
    communeIds: number[],
    dateStrings: string[],
    expectedCommuneCount: number,
    processedCommuneCount: number,
    options: EmptyHistoricStatisticRangeOptions,
  ): Promise<void> {
    let transactionStarted = false;
    try {
      await queryRunner.startTransaction();
      transactionStarted = true;
      await this.assertEmptyHistoricRangeContext(queryRunner, options);
      const communePayload = JSON.stringify(
        communeIds.map((communeId) => ({ communeId })),
      );
      const datePayload = JSON.stringify(
        dateStrings.map((date) => ({
          date,
          restriction: { date, SOU: null, SUP: null, AEP: null },
        })),
      );
      await queryRunner.query(
        `
          INSERT INTO "statistic_commune" ("communeId", "restrictions")
          SELECT input."communeId", '[]'::jsonb
          FROM jsonb_to_recordset($1::jsonb)
            AS input("communeId" integer)
          ON CONFLICT ("communeId") DO NOTHING
        `,
        [communePayload],
      );
      const [updateResult] = await queryRunner.query(
        `
          WITH input AS MATERIALIZED (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb)
              AS value("communeId" integer)
          ), target_dates AS MATERIALIZED (
            SELECT
              target.value ->> 'date' AS "date",
              target.value -> 'restriction' AS restriction,
              target.ordinality
            FROM jsonb_array_elements($2::jsonb)
              WITH ORDINALITY AS target(value, ordinality)
          ), matched AS MATERIALIZED (
            SELECT DISTINCT statistic.id
            FROM input
            JOIN "statistic_commune" statistic
              ON statistic."communeId" = input."communeId"
          ), candidate AS NOT MATERIALIZED (
            SELECT
              matched.id,
              statistic."restrictions" AS "currentRestrictions",
              normalized."nextRestrictions"
            FROM matched
            JOIN "statistic_commune" statistic
              ON statistic.id = matched.id
            CROSS JOIN LATERAL (
              SELECT COALESCE(
                jsonb_agg(
                  item.value
                  ORDER BY
                    item."sortClass",
                    item."sortDate",
                    item.phase,
                    item.ordinality
                ),
                '[]'::jsonb
              ) AS "nextRestrictions"
              FROM (
                SELECT
                  existing.value,
                  CASE
                    WHEN existing.value ->> 'date'
                      ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN 0
                    ELSE 1
                  END AS "sortClass",
                  CASE
                    WHEN existing.value ->> 'date'
                      ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                      THEN existing.value ->> 'date'
                    ELSE NULL
                  END AS "sortDate",
                  0 AS phase,
                  existing.ordinality
                FROM jsonb_array_elements(
                  COALESCE(statistic."restrictions", '[]'::jsonb)
                ) WITH ORDINALITY AS existing(value, ordinality)
                LEFT JOIN target_dates
                  ON target_dates."date" = existing.value ->> 'date'
                WHERE target_dates."date" IS NULL
                UNION ALL
                SELECT
                  target_dates.restriction,
                  0 AS "sortClass",
                  target_dates."date" AS "sortDate",
                  1 AS phase,
                  target_dates.ordinality
                FROM target_dates
              ) item
            ) normalized
          ), updated AS (
            UPDATE "statistic_commune" statistic
            SET "restrictions" = candidate."nextRestrictions"
            FROM candidate
            WHERE statistic.id = candidate.id
              AND candidate."nextRestrictions"
                  IS DISTINCT FROM candidate."currentRestrictions"
            RETURNING statistic.id
          )
          SELECT
            (SELECT COUNT(*)::integer FROM matched) AS matched,
            (SELECT COUNT(*)::integer FROM updated) AS updated,
            (
              (SELECT COUNT(*) FROM matched) -
              (SELECT COUNT(*) FROM updated)
            )::integer AS unchanged
        `,
        [communePayload, datePayload],
      );
      const matchedCount = Number(updateResult?.matched ?? 0);
      const updatedCount = Number(updateResult?.updated ?? 0);
      const unchangedCount = Number(updateResult?.unchanged ?? 0);
      if (matchedCount !== communeIds.length) {
        throw new Error(
          `Lot communal vide incomplet: ${matchedCount}/${communeIds.length} statistiques trouvees`,
        );
      }
      if (updatedCount + unchangedCount !== communeIds.length) {
        throw new Error(
          `Lot communal vide incomplet: ${updatedCount} mises a jour + ${unchangedCount} inchangees / ${communeIds.length} statistiques attendues`,
        );
      }
      await this.markEmptyHistoricSnapshotsProgress(
        queryRunner,
        dateStrings,
        expectedCommuneCount,
        processedCommuneCount,
      );
      await queryRunner.commitTransaction();
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          await queryRunner.rollbackTransaction();
        } catch (rollbackError) {
          this.logger.error(
            "ERREUR LORS DE L'ANNULATION DU LOT VIDE DE STATISTIQUES COMMUNALES",
            rollbackError,
          );
        }
      }
      throw error;
    }
  }

  private async markEmptyHistoricSnapshotsProgress(
    queryRunner: QueryRunner,
    dateStrings: string[],
    expectedCommuneCount: number,
    processedCommuneCount: number,
  ): Promise<void> {
    const [result] = await queryRunner.query(
      `
        WITH progressed AS (
          UPDATE "statistic_commune_snapshot"
          SET "processedCommuneCount" = $3, "updatedAt" = now()
          WHERE "snapshotDate" = ANY($1::date[])
            AND "scope" = 'national'
            AND "status" = 'running'
            AND "expectedCommuneCount" = $2
          RETURNING 1
        )
        SELECT COUNT(*)::integer AS affected FROM progressed
      `,
      [dateStrings, expectedCommuneCount, processedCommuneCount],
    );
    if (Number(result?.affected ?? 0) !== dateStrings.length) {
      throw new Error(
        `La progression de la plage de snapshots communaux ${dateStrings[0]}..${dateStrings[dateStrings.length - 1]} n'a pas ete enregistree`,
      );
    }
  }

  private async markEmptyHistoricSnapshotCompleted(
    queryRunner: QueryRunner,
    dateString: string,
    processedCommuneCount: number,
    options: EmptyHistoricStatisticRangeOptions,
  ): Promise<void> {
    let transactionStarted = false;
    try {
      await queryRunner.startTransaction();
      transactionStarted = true;
      await this.assertEmptyHistoricRangeContext(queryRunner, options);
      await this.markSnapshotCompleted(
        queryRunner,
        dateString,
        'national',
        processedCommuneCount,
        false,
        false,
        false,
        options.sourceRevision,
        options.historicComputeEpoch,
        { requireNationalCoverage: true },
      );
      await queryRunner.commitTransaction();
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          await queryRunner.rollbackTransaction();
        } catch (rollbackError) {
          this.logger.error(
            "ERREUR LORS DE L'ANNULATION DE LA CERTIFICATION DU SNAPSHOT COMMUNAL VIDE",
            rollbackError,
          );
        }
      }
      throw error;
    }
  }

  private async markEmptyHistoricSnapshotsFailed(
    queryRunner: QueryRunner,
    dateStrings: string[],
    processedCommuneCount: number,
    error: unknown,
  ): Promise<void> {
    const query = `
      UPDATE "statistic_commune_snapshot"
      SET "status" = 'failed',
          "processedCommuneCount" = $2,
          "completedAt" = NULL,
          "lastError" = $3,
          "updatedAt" = now()
      WHERE "snapshotDate" = ANY($1::date[])
        AND "scope" = 'national'
        AND "status" = 'running'
    `;
    const parameters = [
      dateStrings,
      processedCommuneCount,
      error instanceof Error ? error.message : String(error),
    ];
    try {
      await queryRunner.query(query, parameters);
    } catch (snapshotError) {
      this.logger.error(
        "ERREUR LORS DE L'ENREGISTREMENT DE L'ECHEC DE LA PLAGE DE SNAPSHOTS COMMUNAUX",
        snapshotError,
      );
      try {
        await this.dataSource.query(query, parameters);
      } catch (fallbackError) {
        this.logger.error(
          "ERREUR LORS DE L'ENREGISTREMENT DE SECOURS DE LA PLAGE DE SNAPSHOTS COMMUNAUX",
          fallbackError,
        );
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
            OR ("snapshotDate" >= $1::date AND "snapshotDate" < $2::date)
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
    sourceRevision?: string,
  ): Promise<void> {
    await queryRunner.query(
      `
        INSERT INTO "statistic_commune_snapshot" (
          "snapshotDate", "scope", "status", "expectedCommuneCount",
          "processedCommuneCount", "startedAt", "completedAt", "lastError",
          "sourceRevision", "createdAt", "updatedAt"
        ) VALUES (
          $1, $2, 'running', $3, 0, now(), NULL, NULL, $4, now(), now()
        )
        ON CONFLICT ("snapshotDate", "scope") DO UPDATE SET
          "status" = 'running',
          "expectedCommuneCount" = EXCLUDED."expectedCommuneCount",
          "processedCommuneCount" = 0,
          "startedAt" = now(),
          "completedAt" = NULL,
          "lastError" = NULL,
          "sourceRevision" = EXCLUDED."sourceRevision",
          "updatedAt" = now()
      `,
      [
        snapshotDate,
        snapshotScope,
        expectedCommuneCount,
        sourceRevision ?? null,
      ],
    );
  }

  private async markSnapshotProgress(
    queryRunner: QueryRunner,
    snapshotDate: string,
    snapshotScope: string,
    processedCommuneCount: number,
  ): Promise<void> {
    const [result] = await queryRunner.query(
      `
        WITH progressed_snapshot AS (
          UPDATE "statistic_commune_snapshot"
          SET "processedCommuneCount" = $3, "updatedAt" = now()
          WHERE "snapshotDate" = $1
            AND "scope" = $2
            AND "status" = 'running'
          RETURNING 1
        )
        SELECT COUNT(*)::integer AS affected FROM progressed_snapshot
      `,
      [snapshotDate, snapshotScope, processedCommuneCount],
    );
    if (Number(result?.affected ?? 0) !== 1) {
      throw new Error(
        `La progression du snapshot communal ${snapshotDate} n'a pas ete enregistree`,
      );
    }
  }

  private async markSnapshotCompleted(
    queryRunner: QueryRunner,
    snapshotDate: string,
    snapshotScope: string,
    processedCommuneCount: number,
    nationalSnapshotAlreadyCompleted: boolean,
    deferCertificationUntilPublication: boolean,
    preserveBootstrapBarrier: boolean,
    sourceRevision?: string,
    historicComputeEpoch?: string,
    certificationOptions: StatisticSnapshotCertificationOptions = {},
  ): Promise<void> {
    if (deferCertificationUntilPublication && snapshotScope !== 'national') {
      throw new Error(
        'Seul un snapshot national peut attendre une publication cartographique',
      );
    }
    const completedStatus = deferCertificationUntilPublication
      ? 'ready'
      : snapshotScope === 'national' || nationalSnapshotAlreadyCompleted
        ? 'completed'
        : 'partial';
    if (
      (sourceRevision !== undefined && !/^\d+$/.test(sourceRevision)) ||
      (historicComputeEpoch !== undefined &&
        (!/^\d+$/.test(historicComputeEpoch) || sourceRevision === undefined))
    ) {
      throw new Error('Invalid statistic snapshot certification context');
    }
    const guardedCertification = sourceRevision !== undefined;
    const requireNationalCoverage =
      certificationOptions.requireNationalCoverage === true;
    const publishCurrentDate = certificationOptions.publishCurrentDate === true;
    if (
      (requireNationalCoverage || publishCurrentDate) &&
      snapshotScope !== 'national'
    ) {
      throw new Error(
        'Seul un snapshot national peut etre certifie avec une couverture nationale',
      );
    }
    if (
      (requireNationalCoverage || publishCurrentDate) &&
      (!guardedCertification || historicComputeEpoch === undefined)
    ) {
      throw new Error(
        'La certification nationale exige une revision source et un epoch historique',
      );
    }

    const coverageCte = requireNationalCoverage
      ? `,
        national_coverage AS MATERIALIZED (
          SELECT
            (SELECT COUNT(*)::integer FROM "departement")
              AS "expectedDepartementCount",
            (
              SELECT COUNT(*)::integer
              FROM "departement" departement
              JOIN "statistic_departement" statistic_departement
                ON statistic_departement."departementId" = departement."id"
              WHERE (
                SELECT COUNT(*)
                FROM jsonb_array_elements(
                  COALESCE(
                    statistic_departement."restrictions",
                    '[]'::jsonb
                  )
                ) AS restriction(value)
                WHERE restriction.value ->> 'date' = $1::text
              ) = 1
            ) AS "departementRestrictionCount",
            (
              SELECT COUNT(*)::integer
              FROM "departement" departement
              WHERE COALESCE(
                (
                  SELECT statistic."departementSituation"::jsonb
                  FROM "statistic" statistic
                  WHERE statistic."date" = $1::date
                ),
                '{}'::jsonb
              ) ? departement."code"
            ) AS "departementSituationCount",
            (
              SELECT COUNT(*)::integer
              FROM jsonb_object_keys(
                COALESCE(
                  (
                    SELECT statistic."departementSituation"::jsonb
                    FROM "statistic" statistic
                    WHERE statistic."date" = $1::date
                  ),
                  '{}'::jsonb
                )
              ) AS situation_key
            ) AS "departementSituationKeyCount"
        )`
      : '';
    const publicationContextCte = publishCurrentDate
      ? `,
        publication_context AS MATERIALIZED (
          SELECT statistic_state."id"
          FROM "statistic_publication_state" statistic_state
          WHERE statistic_state."id" = 1
            AND (
              statistic_state."currentPublishedDate" IS NULL
              OR statistic_state."currentPublishedDate" <= $1::date
            )
          FOR UPDATE OF statistic_state
        )`
      : '';
    const coveragePredicate = requireNationalCoverage
      ? `
            AND EXISTS (
              SELECT 1
              FROM national_coverage coverage
              WHERE coverage."expectedDepartementCount" = 101
                AND coverage."departementRestrictionCount" = 101
                AND coverage."departementSituationCount" = 101
                AND coverage."departementSituationKeyCount" = 101
            )`
      : '';
    const publicationPredicate = publishCurrentDate
      ? `
            AND EXISTS (SELECT 1 FROM publication_context)`
      : '';
    const publishedStateCte = publishCurrentDate
      ? `,
        published_state AS (
          UPDATE "statistic_publication_state" statistic_state
          SET "revision" = statistic_state."revision" + 1,
              "currentPublishedDate" = $1::date,
              "updatedAt" = now()
          FROM completed_snapshot
          WHERE statistic_state."id" = 1
            AND EXISTS (SELECT 1 FROM publication_context)
          RETURNING statistic_state."revision"
        )`
      : '';
    const resultProjection = `
          (SELECT COUNT(*)::integer FROM completed_snapshot) AS affected${
            publishCurrentDate
              ? ', (SELECT COUNT(*)::integer FROM published_state) AS "publishedStateCount"'
              : ''
          }${
            requireNationalCoverage
              ? `,
          coverage."expectedDepartementCount",
          coverage."departementRestrictionCount",
          coverage."departementSituationCount",
          coverage."departementSituationKeyCount"`
              : ''
          }`;
    const ownsCertificationTransaction = !queryRunner.isTransactionActive;
    let certificationTransactionStarted = false;
    try {
      if (ownsCertificationTransaction) {
        await queryRunner.startTransaction();
        certificationTransactionStarted = true;
      }
      const [result] = await queryRunner.query(
        guardedCertification
          ? `
        WITH current_context AS MATERIALIZED (
          SELECT
            source_state."revision" AS "sourceRevision",
            config."historicComputeEpoch" AS "historicComputeEpoch"
          FROM "zone_publication_source_state" source_state
          CROSS JOIN "config" config
          WHERE source_state."id" = 1
            AND config."id" = 1
          FOR SHARE OF source_state, config
        )${coverageCte}${publicationContextCte},
        completed_snapshot AS (
          UPDATE "statistic_commune_snapshot" snapshot
          SET "status" = $3::varchar,
              "processedCommuneCount" = $4,
              "completedAt" = CASE
                WHEN $3::varchar = 'ready' THEN NULL
                ELSE now()
              END,
              "lastError" = NULL,
              "updatedAt" = now()
          FROM current_context
          WHERE snapshot."snapshotDate" = $1::date
            AND snapshot."scope" = $2
            AND snapshot."status" = 'running'
            AND snapshot."expectedCommuneCount" = $4
            AND snapshot."sourceRevision" = $5::bigint
            AND current_context."sourceRevision" = $5::bigint
            AND (
              $6::bigint IS NULL
              OR current_context."historicComputeEpoch" = $6::bigint
            )${coveragePredicate}${publicationPredicate}
          RETURNING 1
        )${publishedStateCte}
        SELECT ${resultProjection}
        ${requireNationalCoverage ? 'FROM national_coverage coverage' : ''}
      `
          : `
        WITH completed_snapshot AS (
          UPDATE "statistic_commune_snapshot"
          SET "status" = $3::varchar,
              "processedCommuneCount" = $4,
              "completedAt" = CASE
                WHEN $3::varchar = 'ready' THEN NULL
                ELSE now()
              END,
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
        guardedCertification
          ? [
              snapshotDate,
              snapshotScope,
              completedStatus,
              processedCommuneCount,
              sourceRevision,
              historicComputeEpoch ?? null,
            ]
          : [
              snapshotDate,
              snapshotScope,
              completedStatus,
              processedCommuneCount,
            ],
      );
      if (
        requireNationalCoverage &&
        (Number(result?.expectedDepartementCount ?? 0) !== 101 ||
          Number(result?.departementRestrictionCount ?? 0) !== 101 ||
          Number(result?.departementSituationCount ?? 0) !== 101 ||
          Number(result?.departementSituationKeyCount ?? 0) !== 101)
      ) {
        throw new Error(
          `Couverture statistique departementale incomplete pour ${snapshotDate}: ` +
            `${Number(result?.departementRestrictionCount ?? 0)}/101 restrictions, ` +
            `${Number(result?.departementSituationCount ?? 0)}/101 situations, ` +
            `${Number(result?.departementSituationKeyCount ?? 0)}/101 cles`,
        );
      }
      if (Number(result?.affected ?? 0) !== 1) {
        throw new Error(
          `Le snapshot communal ${snapshotDate} ne couvre pas toutes les communes attendues`,
        );
      }
      if (
        publishCurrentDate &&
        Number(result?.publishedStateCount ?? 0) !== 1
      ) {
        throw new Error(
          `La publication statistique courante ${snapshotDate} n'a pas ete certifiee`,
        );
      }
      if (snapshotScope === 'national' && !deferCertificationUntilPublication) {
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
        if (!preserveBootstrapBarrier) {
          await queryRunner.query(
            `
            DELETE FROM "statistic_commune_snapshot"
            WHERE "scope" = 'bootstrap'
          `,
          );
        }
      }
      if (ownsCertificationTransaction) {
        await queryRunner.commitTransaction();
        certificationTransactionStarted = false;
      }
    } catch (error) {
      if (certificationTransactionStarted) {
        try {
          await queryRunner.rollbackTransaction();
        } catch (rollbackError) {
          this.logger.error(
            'ERREUR LORS DU ROLLBACK DE LA CERTIFICATION DU SNAPSHOT COMMUNAL',
            rollbackError,
          );
        }
      }
      throw error;
    }
  }

  private async markSnapshotFailed(
    queryRunner: QueryRunner,
    snapshotDate: string,
    snapshotScope: string,
    processedCommuneCount: number,
    error: unknown,
  ): Promise<void> {
    const query = `
      UPDATE "statistic_commune_snapshot"
      SET "status" = 'failed',
          "processedCommuneCount" = $3,
          "completedAt" = NULL,
          "lastError" = $4,
          "updatedAt" = now()
      WHERE "snapshotDate" = $1
        AND "scope" = $2
    `;
    const parameters = [
      snapshotDate,
      snapshotScope,
      processedCommuneCount,
      error instanceof Error ? error.message : String(error),
    ];
    try {
      await queryRunner.query(query, parameters);
    } catch (snapshotError) {
      this.logger.error(
        "ERREUR LORS DE L'ENREGISTREMENT DE L'ECHEC DU SNAPSHOT COMMUNAL",
        snapshotError,
      );
      try {
        await this.dataSource.query(query, parameters);
      } catch (fallbackError) {
        this.logger.error(
          "ERREUR LORS DE L'ENREGISTREMENT DE SECOURS DU SNAPSHOT COMMUNAL",
          fallbackError,
        );
      }
    }
  }

  async computeByMonth(
    date?: Moment,
    departementCodes?: string[],
    options?: MonthlyStatisticComputationOptions,
  ) {
    this.logger.log('COMPUTE BY MONTH');

    const dateDebut = date
      ? moment.utc(date.format('YYYY-MM-DD'), 'YYYY-MM-DD').startOf('month')
      : moment.utc('2013-01-01', 'YYYY-MM-DD');
    const dateFin = options?.aggregateThrough
      ? moment.utc(options.aggregateThrough.format('YYYY-MM-DD'), 'YYYY-MM-DD')
      : moment.utc();
    if (!dateDebut.isValid() || !dateFin.isValid()) {
      throw new Error('Invalid monthly statistic date range');
    }

    for (
      let m = moment(dateDebut);
      m.isSameOrBefore(dateFin, 'month');
      m.add(1, 'month')
    ) {
      this.logger.log(`COMPUTE STAT BY MONTH ${m.format('YYYY-MM')}`);
      await this.computeCommuneStatisticsRestrictionsByMonth(
        m.toDate(),
        departementCodes,
        false,
        options?.aggregateThrough?.format('YYYY-MM-DD'),
        options?.allowedReadySnapshot,
      );
    }
  }

  async computeCommuneStatisticsRestrictionsByMonth(
    date: Date,
    departementCodes?: string[],
    allowCurrentSnapshot = false,
    aggregateThrough?: string,
    allowedReadySnapshot?: {
      date: string;
      sourceRevision: string;
    },
  ) {
    if (
      aggregateThrough &&
      !moment.utc(aggregateThrough, 'YYYY-MM-DD', true).isValid()
    ) {
      throw new Error(`Invalid monthly statistic bound: ${aggregateThrough}`);
    }
    if (
      allowedReadySnapshot &&
      (allowedReadySnapshot.date !== aggregateThrough ||
        !/^\d+$/.test(allowedReadySnapshot.sourceRevision))
    ) {
      throw new Error('Invalid allowed ready monthly snapshot');
    }
    const currentDate = date.toISOString().slice(0, 10);
    const dateMoment = moment.utc(currentDate, 'YYYY-MM-DD');
    const month = dateMoment.format('YYYY-MM');
    const monthStart = dateMoment.clone().startOf('month').format('YYYY-MM-DD');
    const monthEnd = dateMoment
      .clone()
      .add(1, 'month')
      .startOf('month')
      .format('YYYY-MM-DD');
    const snapshotScope = this.getSnapshotScope(departementCodes);
    const [result] = await this.dataSource.query(
      `
          WITH current_snapshot_ready AS MATERIALIZED (
            SELECT 1
            FROM "statistic_commune_snapshot" snapshot
            WHERE $5::boolean
              AND snapshot."snapshotDate" = $7::date
              AND snapshot."scope" = $6
              AND snapshot."status" = 'running'
              AND snapshot."processedCommuneCount" = snapshot."expectedCommuneCount"
            LIMIT 1
          ), allowed_ready_snapshot AS MATERIALIZED (
            SELECT 1
            FROM "statistic_commune_snapshot" snapshot
            WHERE $9::bigint IS NOT NULL
              AND $10::date IS NOT NULL
              AND snapshot."snapshotDate" = $10::date
              AND snapshot."scope" = 'national'
              AND snapshot."status" = 'ready'
              AND snapshot."sourceRevision" = $9::bigint
            LIMIT 1
          ), incomplete_snapshot AS MATERIALIZED (
            SELECT 1
            FROM "statistic_commune_snapshot" snapshot
            WHERE snapshot."status" <> 'completed'
              AND (
                snapshot."scope" = 'bootstrap'
                OR NOT EXISTS (
                  SELECT 1
                  FROM "statistic_commune_snapshot" failed_national_snapshot
                  WHERE failed_national_snapshot."snapshotDate" =
                        snapshot."snapshotDate"
                    AND failed_national_snapshot."scope" = 'national'
                    AND failed_national_snapshot."status" = 'failed'
                    AND failed_national_snapshot."sourceRevision" IS NOT NULL
                )
              )
              AND (
                snapshot."scope" = 'bootstrap'
                OR (
                snapshot."snapshotDate" >= $3::date
                AND snapshot."snapshotDate" < $4::date
                AND (
                  $8::date IS NULL
                  OR snapshot."snapshotDate" <= $8::date
                )
              )
              )
              AND NOT (
                EXISTS (SELECT 1 FROM current_snapshot_ready)
                AND (
                  snapshot."scope" = 'bootstrap'
                  OR (
                    snapshot."snapshotDate" = $7::date
                    AND (
                      $6 = 'national'
                      OR snapshot."scope" = $6
                    )
                  )
                )
              )
              AND NOT (
                EXISTS (SELECT 1 FROM allowed_ready_snapshot)
                AND (
                  snapshot."scope" = 'bootstrap'
                  OR (
                    snapshot."snapshotDate" = $10::date
                    AND snapshot."scope" = 'national'
                    AND snapshot."status" = 'ready'
                    AND snapshot."sourceRevision" = $9::bigint
                  )
                )
              )
            LIMIT 1
          ), publication_barrier AS MATERIALIZED (
            SELECT
              EXISTS(SELECT 1 FROM incomplete_snapshot)
              OR (
                $9::bigint IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM allowed_ready_snapshot)
              ) AS blocked
          ), selected_statistics AS MATERIALIZED (
            SELECT statistic.id
            FROM "statistic_commune" statistic
            JOIN commune ON commune.id = statistic."communeId"
            JOIN departement ON departement.id = commune."departementId"
            WHERE ($1::text[] IS NULL OR departement.code = ANY($1::text[]))
              AND NOT (SELECT blocked FROM publication_barrier)
          ), monthly AS (
            SELECT
              statistic.id,
              COALESCE(
                SUM(
                  CASE GREATEST(
                    CASE daily.value ->> 'AEP'
                      WHEN 'vigilance' THEN 2
                      WHEN 'alerte' THEN 3
                      WHEN 'alerte_renforcee' THEN 4
                      WHEN 'crise' THEN 5
                      ELSE 1
                    END,
                    CASE daily.value ->> 'SOU'
                      WHEN 'vigilance' THEN 2
                      WHEN 'alerte' THEN 3
                      WHEN 'alerte_renforcee' THEN 4
                      WHEN 'crise' THEN 5
                      ELSE 1
                    END,
                    CASE daily.value ->> 'SUP'
                      WHEN 'vigilance' THEN 2
                      WHEN 'alerte' THEN 3
                      WHEN 'alerte_renforcee' THEN 4
                      WHEN 'crise' THEN 5
                      ELSE 1
                    END
                  )
                    WHEN 2 THEN 0.5
                    WHEN 3 THEN 2
                    WHEN 4 THEN 3
                    WHEN 5 THEN 4
                    ELSE 0
                  END
                ) FILTER (WHERE daily.value IS NOT NULL),
                0
              ) AS ponderation
            FROM "statistic_commune" statistic
            JOIN selected_statistics selected
              ON selected.id = statistic.id
            LEFT JOIN LATERAL jsonb_array_elements(
              COALESCE(statistic."restrictions", '[]'::jsonb)
            ) AS daily(value)
              ON daily.value ->> 'date' LIKE $2 || '-%'
             AND NOT EXISTS (
               SELECT 1
               FROM "statistic_commune_snapshot" failed_national_snapshot
               WHERE failed_national_snapshot."snapshotDate" =
                     (daily.value ->> 'date')::date
                 AND failed_national_snapshot."scope" = 'national'
                 AND failed_national_snapshot."status" = 'failed'
                 AND failed_national_snapshot."sourceRevision" IS NOT NULL
             )
             AND (
               $8::date IS NULL
               OR (daily.value ->> 'date')::date <= $8::date
             )
            GROUP BY statistic.id
          ), updated AS (
            UPDATE "statistic_commune" statistic
            SET "restrictionsByMonth" =
              (
                SELECT COALESCE(
                  jsonb_agg(
                    sorted.value
                    ORDER BY
                      CASE
                        WHEN sorted.value ->> 'date'
                          ~ '^[0-9]{4}-[0-9]{2}$' THEN 0
                        ELSE 1
                      END,
                      CASE
                        WHEN sorted.value ->> 'date'
                          ~ '^[0-9]{4}-[0-9]{2}$'
                          THEN sorted.value ->> 'date'
                        ELSE NULL
                      END,
                      sorted.ordinality
                  ),
                  '[]'::jsonb
                )
                FROM jsonb_array_elements(
                  COALESCE(
                    (
                      SELECT jsonb_agg(
                        CASE
                          WHEN item.value ->> 'date' = $2
                            THEN jsonb_build_object(
                              'date', $2::text,
                              'ponderation', monthly.ponderation
                            )
                          ELSE item.value
                        END
                        ORDER BY item.ordinality
                      )
                      FROM jsonb_array_elements(
                        COALESCE(
                          statistic."restrictionsByMonth",
                          '[]'::jsonb
                        )
                      ) WITH ORDINALITY AS item(value, ordinality)
                    ),
                    '[]'::jsonb
                  ) || CASE
                    WHEN NOT EXISTS (
                      SELECT 1
                      FROM jsonb_array_elements(
                        COALESCE(
                          statistic."restrictionsByMonth",
                          '[]'::jsonb
                        )
                      ) AS existing(value)
                      WHERE existing.value ->> 'date' = $2
                    )
                    THEN jsonb_build_array(
                      jsonb_build_object(
                        'date', $2::text,
                        'ponderation', monthly.ponderation
                      )
                    )
                    ELSE '[]'::jsonb
                  END
                ) WITH ORDINALITY AS sorted(value, ordinality)
              )
            FROM monthly
            WHERE statistic.id = monthly.id
            RETURNING statistic.id
          )
          SELECT
            (SELECT blocked FROM publication_barrier) AS blocked,
            (SELECT COUNT(*)::integer FROM selected_statistics) AS expected,
            (SELECT COUNT(*)::integer FROM updated) AS affected
      `,
      [
        departementCodes?.length ? [...new Set(departementCodes)] : null,
        month,
        monthStart,
        monthEnd,
        allowCurrentSnapshot,
        snapshotScope,
        currentDate,
        aggregateThrough ?? null,
        allowedReadySnapshot?.sourceRevision ?? null,
        allowedReadySnapshot?.date ?? null,
      ],
    );
    if (result?.blocked === true) {
      throw new Error(`Calcul mensuel communal bloque pour ${month}`);
    }
    if (Number(result?.affected ?? 0) !== Number(result?.expected ?? 0)) {
      throw new Error(
        `Calcul mensuel communal incomplet: ${Number(result?.affected ?? 0)}/${Number(result?.expected ?? 0)} statistiques mises a jour`,
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
            SELECT jsonb_agg(
              item.value
              ORDER BY
                CASE
                  WHEN item.value ->> 'date'
                    ~ '^[0-9]{4}-[0-9]{2}$' THEN 0
                  ELSE 1
                END,
                CASE
                  WHEN item.value ->> 'date'
                    ~ '^[0-9]{4}-[0-9]{2}$'
                    THEN item.value ->> 'date'
                  ELSE NULL
                END,
                item.ordinality
            )
            FROM jsonb_array_elements(restrictionsByMonth)
              WITH ORDINALITY AS item(value, ordinality)
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
}
