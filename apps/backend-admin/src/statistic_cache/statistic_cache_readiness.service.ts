import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { readStatisticCachePositiveInteger } from './statistic_cache.config';
import { sourceRevisionColumn } from '../zone_publication/zone_publication.config';

export interface StatisticCacheReadyIdentity {
  publicationId: string;
  statisticRevision: string;
  statisticPublishedDate: string;
  statisticFingerprint: string;
  sourceRevision: string;
}

type StatisticCacheReadinessRow = StatisticCacheReadyIdentity & {
  artifactCount: string | number;
  liveInstances: string | number;
  readyInstances: string | number;
};

@Injectable()
export class StatisticCacheReadinessService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async getReadyPublication(
    scheduledFor: string,
    expectedSourceRevision: string,
  ): Promise<StatisticCacheReadyIdentity | null> {
    const leaseSeconds = readStatisticCachePositiveInteger(
      'STATISTIC_CACHE_INSTANCE_LEASE_SECONDS',
      30,
    );
    const minimumReadyInstances = readStatisticCachePositiveInteger(
      'STATISTIC_CACHE_MIN_READY_INSTANCES',
      2,
    );
    const [row] = (await this.dataSource.query(
      `
        WITH active_publication AS (
          SELECT
            publication."id"::text AS "publicationId",
            publication."statisticRevision"::text AS "statisticRevision",
            publication."currentPublishedDate"::text
              AS "statisticPublishedDate",
            publication."contentFingerprint" AS "statisticFingerprint",
            publication."sourceRevision"::text AS "sourceRevision"
          FROM "statistic_cache_state" cache_state
          JOIN "statistic_cache_publication" publication
            ON publication."id" = cache_state."activePublicationId"
          JOIN "statistic_publication_state" statistic_state
            ON statistic_state."id" = 1
          JOIN "zone_publication_source_state" source_state
            ON source_state."id" = 1
          JOIN "config" config
            ON config."id" = 1
          WHERE cache_state."id" = 1
            AND cache_state."historicRecoveryMonthlyFrom" IS NULL
            AND publication."status" = 'active'
            AND publication."mode" = 'legacy-bootstrap'
            AND publication."schemaVersion" = 1
            AND publication."currentPublishedDate" = $1::date
            AND publication."latestDate" = $1::date
            AND publication."statisticRevision" = statistic_state."revision"
            AND statistic_state."currentPublishedDate" = $1::date
            AND publication."sourceRevision" = ${sourceRevisionColumn('source_state')}
            AND ${sourceRevisionColumn('source_state')} = $2::bigint
            AND publication."historicComputeEpoch" =
                config."historicComputeEpoch"
            AND (
              (
                statistic_state."historicDirtyFrom" IS NOT NULL
                AND statistic_state."historicDirtyThrough" >=
                    ($1::date - interval '1 day')::date
              )
              OR (
                statistic_state."historicDirtyFrom" IS NULL
                AND statistic_state."historicDirtyThrough" IS NULL
                AND statistic_state."historicPublishedThrough" >=
                    ($1::date - interval '1 day')::date
                AND config."computeMapDate" >=
                    ($1::date - interval '1 day')::date
                AND config."computeStatsDate" >=
                    ($1::date - interval '1 day')::date
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM "statistic_commune_snapshot" incomplete_snapshot
              WHERE incomplete_snapshot."status" <> 'completed'
                OR incomplete_snapshot."processedCommuneCount" <>
                   incomplete_snapshot."expectedCommuneCount"
            )
        )
        SELECT
          active_publication.*,
          (
            SELECT COUNT(*)::integer
            FROM "statistic_cache_artifact" artifact
            WHERE artifact."publicationId" = active_publication."publicationId"::uuid
          ) AS "artifactCount",
          instance_summary."liveInstances",
          instance_summary."readyInstances"
        FROM active_publication
        CROSS JOIN LATERAL (
          SELECT
            COUNT(*)::integer AS "liveInstances",
            COUNT(*) FILTER (
              WHERE instance."statisticCachePublicationId" =
                    active_publication."publicationId"::uuid
                AND instance."statisticRevision" =
                    active_publication."statisticRevision"::bigint
                AND instance."statisticPublishedDate" =
                    active_publication."statisticPublishedDate"::date
                AND instance."statisticFingerprint" =
                    active_publication."statisticFingerprint"
                AND instance."statisticLastError" IS NULL
            )::integer AS "readyInstances"
          FROM "zone_publication_instance" instance
          WHERE instance."heartbeatAt" >=
            now() - ($3 * interval '1 second')
        ) instance_summary
      `,
      [scheduledFor, expectedSourceRevision, leaseSeconds],
    )) as StatisticCacheReadinessRow[];
    if (
      !row ||
      Number(row.artifactCount) !== 3 ||
      Number(row.liveInstances) < minimumReadyInstances ||
      Number(row.readyInstances) !== Number(row.liveInstances)
    ) {
      return null;
    }
    return {
      publicationId: String(row.publicationId),
      statisticRevision: String(row.statisticRevision),
      statisticPublishedDate: String(row.statisticPublishedDate).slice(0, 10),
      statisticFingerprint: String(row.statisticFingerprint),
      sourceRevision: String(row.sourceRevision),
    };
  }

  async assertReadyPublication(
    expected: StatisticCacheReadyIdentity,
  ): Promise<void> {
    const current = await this.getReadyPublication(
      expected.statisticPublishedDate,
      expected.sourceRevision,
    );
    if (
      !current ||
      current.publicationId !== expected.publicationId ||
      current.statisticRevision !== expected.statisticRevision ||
      current.statisticFingerprint !== expected.statisticFingerprint
    ) {
      throw new Error(
        `Statistic cache quorum changed for ${expected.statisticPublishedDate}/${expected.sourceRevision}`,
      );
    }
  }
}
