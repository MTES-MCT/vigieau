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
const COMMUNE_STATISTICS_BATCH_SIZE = 250;
const STATISTIC_ZONE_TYPES = ['SUP', 'SOU', 'AEP'] as const;
const STATISTIC_SEVERITIES = [
  'vigilance',
  'alerte',
  'alerte_renforcee',
  'crise',
] as const;

type StatisticSeverity = (typeof STATISTIC_SEVERITIES)[number];

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
  sourceRevision?: string;
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
    hooks?: StatisticSnapshotHooks,
  ) {
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

      const batchSize = COMMUNE_STATISTICS_BATCH_SIZE;
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
          WITH input AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb)
              AS value("communeId" integer, restriction jsonb)
          ), updated AS (
            UPDATE "statistic_commune" statistic
            SET "restrictions" =
              COALESCE(
                (
                  SELECT jsonb_agg(
                    CASE
                      WHEN item.value ->> 'date' = $2 THEN input.restriction
                      ELSE item.value
                    END
                    ORDER BY item.ordinality
                  )
                  FROM jsonb_array_elements(
                    COALESCE(statistic."restrictions", '[]'::jsonb)
                  ) WITH ORDINALITY AS item(value, ordinality)
                ),
                '[]'::jsonb
              ) || CASE
                WHEN NOT EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(
                    COALESCE(statistic."restrictions", '[]'::jsonb)
                  ) AS existing(value)
                  WHERE existing.value ->> 'date' = $2
                )
                THEN jsonb_build_array(input.restriction)
                ELSE '[]'::jsonb
              END
            FROM input
            WHERE statistic."communeId" = input."communeId"
            RETURNING statistic.id
          )
          SELECT COUNT(*)::integer AS affected FROM updated
        `,
        [payload, dateString],
      );
      if (Number(updateResult?.affected ?? 0) !== restrictions.length) {
        throw new Error(
          `Lot communal incomplet: ${Number(updateResult?.affected ?? 0)}/${restrictions.length} statistiques mises a jour`,
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
    const [result] = await queryRunner.query(
      `
        WITH completed_snapshot AS (
          UPDATE "statistic_commune_snapshot"
          SET "status" = $3,
              "processedCommuneCount" = $4,
              "completedAt" = CASE WHEN $3 = 'ready' THEN NULL ELSE now() END,
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
             AND (
               $8::date IS NULL
               OR (daily.value ->> 'date')::date <= $8::date
             )
            GROUP BY statistic.id
          ), updated AS (
            UPDATE "statistic_commune" statistic
            SET "restrictionsByMonth" =
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
                    COALESCE(statistic."restrictionsByMonth", '[]'::jsonb)
                  ) WITH ORDINALITY AS item(value, ordinality)
                ),
                '[]'::jsonb
              ) || CASE
                WHEN NOT EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(
                    COALESCE(statistic."restrictionsByMonth", '[]'::jsonb)
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
}
