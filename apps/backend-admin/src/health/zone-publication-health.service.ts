import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ClockHeartbeatService } from '../core/scheduling/clock-heartbeat.service';
import {
  getScheduledCivilDate,
  NATIONAL_COMPUTE_START_HOUR,
  shiftCivilDate,
} from '../core/scheduling/daily-job-schedule';
import {
  isZonePublicationEnabled,
  sourceRevisionColumn,
  ZONE_PUBLICATION_MATERIALIZATION_VERSION,
} from '../zone_publication/zone_publication.config';

const DEFAULT_INSTANCE_LEASE_SECONDS = 30;
const DEFAULT_MINIMUM_READY_INSTANCES = 2;
const DEFAULT_PROGRESS_STALE_AFTER_SECONDS = 30 * 60;

export type PublicZonePublicationHealthStatus =
  | 'healthy'
  | 'updating'
  | 'stale'
  | 'unavailable';

export type PublicZonePublicationHistoricStatus =
  | 'complete'
  | 'certified'
  | 'incomplete'
  | 'unknown';

export interface PublicZonePublicationHealthChecks {
  enabled: boolean;
  automaticPublishing: boolean;
  clock: boolean;
  activeServing: boolean;
  activeCurrent: boolean;
  candidateClear: boolean;
  legacyPromotion: boolean;
  currentStatistics: boolean;
  currentSnapshot: boolean;
  historicStatistics: boolean;
  certifiedHistoricRepair: boolean;
  historicClean: boolean;
  historicCursors: boolean;
  certifiedRun: boolean;
  historicRun: boolean;
  snapshotsComplete: boolean;
  recentProgress: boolean;
}

export interface PublicZonePublicationHealth {
  status: PublicZonePublicationHealthStatus;
  historicStatus: PublicZonePublicationHistoricStatus;
  serving: boolean;
  businessDate: string;
  requiredHistoricThrough: string;
  checks: PublicZonePublicationHealthChecks | null;
}

@Injectable()
export class ZonePublicationHealthService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly clockHeartbeat: ClockHeartbeatService,
  ) {}

  async getHealthStatus(
    now = new Date(),
  ): Promise<PublicZonePublicationHealth> {
    const businessDate = getScheduledCivilDate(
      now,
      NATIONAL_COMPUTE_START_HOUR,
    );
    const requiredHistoricThrough = shiftCivilDate(businessDate, -1);
    const unavailable = (): PublicZonePublicationHealth => ({
      status: 'unavailable',
      historicStatus: 'unknown',
      serving: false,
      businessDate,
      requiredHistoricThrough,
      checks: null,
    });

    try {
      const leaseSeconds = this.readPositiveInteger(
        'ZONE_PUBLICATION_INSTANCE_LEASE_SECONDS',
        DEFAULT_INSTANCE_LEASE_SECONDS,
      );
      const minimumReadyInstances = this.readPositiveInteger(
        'ZONE_PUBLICATION_MIN_READY_INSTANCES',
        DEFAULT_MINIMUM_READY_INSTANCES,
      );
      const progressStaleAfterSeconds = this.readPositiveInteger(
        'ZONE_PUBLICATION_HEALTH_PROGRESS_STALE_AFTER_SECONDS',
        DEFAULT_PROGRESS_STALE_AFTER_SECONDS,
      );
      const [[state], clock] = await Promise.all([
        this.dataSource.query(
          `
            SELECT
              ${sourceRevisionColumn('source_state')} AS "sourceRevision",
              source_state."updatedAt" AS "sourceUpdatedAt",
              publication_state."updatedAt" AS "stateUpdatedAt",
              publication_state."automaticPublishingPaused"
                AS "automaticPublishingPaused",
              publication_state."candidatePublicationId" IS NOT NULL
                AS "hasCandidate",
              publication_state."candidateRequestedAt"
                AS "candidateRequestedAt",
              active."status" AS "activeStatus",
              active."sourceRevision" AS "activeSourceRevision",
              active."materializationVersion" AS "activeMaterializationVersion",
              (active."sourceComputedAt" AT TIME ZONE 'Europe/Paris')::date::text
                AS "activeBusinessDate",
              active."legacyPromotedAt" AS "legacyPromotedAt",
              active."promotionError" AS "promotionError",
              active_instances."liveInstances" AS "liveInstances",
              active_instances."readyInstances" AS "activeReadyInstances",
              statistic_state."currentPublishedDate"::text
                AS "currentPublishedDate",
              statistic_state."historicPublishedThrough"::text
                AS "historicPublishedThrough",
              statistic_state."historicDirtyFrom"::text AS "historicDirtyFrom",
              statistic_state."historicDirtyThrough"::text
                AS "historicDirtyThrough",
              statistic_state."updatedAt" AS "statisticStateUpdatedAt",
              certified_repair.id IS NOT NULL
                AS "certifiedHistoricRepair",
              certified_repair."dateThrough"::text
                AS "certifiedHistoricThrough",
              config."computeMapDate"::text AS "computeMapDate",
              config."computeStatsDate"::text AS "computeStatsDate",
              CASE
                WHEN current_run."updatedAt" IS NOT NULL THEN GREATEST(
                  config."computeMapUpdatedAt",
                  config."computeStatsUpdatedAt"
                )
                ELSE NULL
              END AS "historicCursorProgressAt",
              snapshots."incompleteCount" AS "incompleteSnapshotCount",
              snapshots."latestUpdatedAt" AS "latestSnapshotUpdatedAt",
              EXISTS (
                SELECT 1
                FROM "statistic_commune_snapshot" current_snapshot
                WHERE current_snapshot."snapshotDate" = $4::date
                  AND current_snapshot."scope" = 'national'
                  AND current_snapshot."status" = 'completed'
                  AND current_snapshot."sourceRevision" =
                      active."sourceRevision"
                  AND current_snapshot."processedCommuneCount" =
                      current_snapshot."expectedCommuneCount"
              ) AS "currentSnapshot",
              current_publication."latestProgressAt"
                AS "latestPublicationProgressAt",
              candidate_instances."latestHeartbeatAt"
                AS "latestCandidateHeartbeatAt",
              current_run."updatedAt" AS "currentRunUpdatedAt",
              EXISTS (
                SELECT 1
                FROM "external_publication_run" daily_run
                WHERE daily_run."jobKey" = 'compute:national-daily'
                  AND daily_run."status" = 'succeeded'
                  AND daily_run."scheduledFor" = $4::date
                  AND daily_run."scheduledFor" =
                    (active."sourceComputedAt" AT TIME ZONE 'Europe/Paris')::date
                  AND daily_run."metadata" @> jsonb_build_object(
                    'sourceRevision', active."sourceRevision"::text,
                    'materializationVersion', active."materializationVersion"
                  )
                  AND daily_run."scheduledFor" = (
                    SELECT MAX(latest_daily."scheduledFor")
                    FROM "external_publication_run" latest_daily
                    WHERE latest_daily."jobKey" = 'compute:national-daily'
                      AND latest_daily."metadata" @> jsonb_build_object(
                        'sourceRevision', active."sourceRevision"::text,
                        'materializationVersion', active."materializationVersion"
                      )
                  )
                  AND (
                    daily_run."metadata" ->> 'publicationId' = active."id"::text
                    OR EXISTS (
                      SELECT 1
                      FROM "zone_publication" failed_publication
                      WHERE failed_publication."id"::text =
                            daily_run."metadata" ->> 'publicationId'
                        AND failed_publication."status" = 'failed'
                        AND failed_publication."sourceRevision" =
                            active."sourceRevision"
                        AND failed_publication."materializationVersion" =
                            active."materializationVersion"
                        AND (
                          failed_publication."sourceComputedAt"
                            AT TIME ZONE 'Europe/Paris'
                        )::date = daily_run."scheduledFor"
                    )
                  )
              ) AS "certifiedCurrentRun",
              EXISTS (
                SELECT 1
                FROM "external_publication_run" historic_run
                WHERE historic_run."jobKey" = 'compute:historic-catchup'
                  AND historic_run."status" = 'succeeded'
                  AND historic_run."scheduledFor" = $4::date
                  AND historic_run."metadata" @> jsonb_build_object(
                    'sourceRevision', active."sourceRevision"::text,
                    'materializationVersion', active."materializationVersion"
                  )
                  AND historic_run."metadata" @> jsonb_build_object(
                    'historicMapCursor', config."computeMapDate"::text,
                    'historicStatsCursor', config."computeStatsDate"::text,
                    'historicMapGeneration', config."computeMapGeneration"::text,
                    'historicStatsGeneration', config."computeStatsGeneration"::text
                  )
              ) AS "certifiedHistoricRun"
            FROM "zone_publication_source_state" source_state
            INNER JOIN "zone_publication_state" publication_state
              ON publication_state."id" = 1
            LEFT JOIN "zone_publication" active
              ON active."id" = publication_state."activePublicationId"
            LEFT JOIN "statistic_publication_state" statistic_state
              ON statistic_state."id" = 1
            LEFT JOIN "config" config ON config."id" = 1
            LEFT JOIN LATERAL (
              SELECT repair.id, repair."dateThrough"
              FROM "active_certified_history_repair" repair
              WHERE repair."activationKind" = 'statistics-only'
                AND repair."dateFrom" = statistic_state."historicDirtyFrom"
                AND repair."dateThrough" =
                    statistic_state."historicDirtyThrough"
                AND repair."publicationRevisionAfter" <=
                    statistic_state.revision
                AND NOT EXISTS (
                  SELECT 1
                  FROM generate_series(
                    repair."dateThrough" + 1,
                    $5::date,
                    '1 day'::interval
                  ) required_day(value)
                  WHERE NOT EXISTS (
                    SELECT 1
                    FROM "statistic_commune_snapshot" snapshot
                    WHERE snapshot."snapshotDate" = required_day.value::date
                      AND snapshot.scope = 'national'
                      AND snapshot.status = 'completed'
                      AND snapshot."processedCommuneCount" =
                          snapshot."expectedCommuneCount"
                  )
                )
              ORDER BY repair."attestedThroughEpoch" DESC
              LIMIT 1
            ) certified_repair ON true
            LEFT JOIN LATERAL (
              SELECT
                COUNT(*)::integer AS "liveInstances",
                COUNT(*) FILTER (
                  WHERE instance."lastError" IS NULL
                    AND instance."activePublicationId" = active."id"
                    AND instance."zoneCount" = active."zoneCount"
                    AND instance."communeLinkCount" = active."communeLinkCount"
                    AND instance."contentFingerprint" = active."contentFingerprint"
                )::integer AS "readyInstances"
              FROM "zone_publication_instance" instance
              WHERE instance."heartbeatAt" >=
                    $1::timestamptz - ($2::integer * interval '1 second')
            ) active_instances ON true
            LEFT JOIN LATERAL (
              SELECT
                COUNT(*) FILTER (
                  WHERE snapshot."status" NOT IN ('ready', 'completed')
                     OR snapshot."processedCommuneCount" <>
                        snapshot."expectedCommuneCount"
                )::integer AS "incompleteCount",
                MAX(snapshot."updatedAt") FILTER (
                  WHERE snapshot."scope" <> 'bootstrap'
                    AND snapshot."sourceRevision" = ${sourceRevisionColumn('source_state')}
                    AND (
                      snapshot."snapshotDate" = $4::date
                      OR (
                        statistic_state."historicDirtyFrom" IS NOT NULL
                        AND statistic_state."historicDirtyThrough" IS NOT NULL
                        AND snapshot."snapshotDate" BETWEEN
                          statistic_state."historicDirtyFrom"
                          AND statistic_state."historicDirtyThrough"
                      )
                    )
                ) AS "latestUpdatedAt"
              FROM "statistic_commune_snapshot" snapshot
            ) snapshots ON true
            LEFT JOIN LATERAL (
              SELECT MAX(GREATEST(
                publication."createdAt",
                publication."validatedAt",
                publication."candidateAt"
              )) AS "latestProgressAt"
              FROM "zone_publication" publication
              WHERE publication."sourceRevision" = ${sourceRevisionColumn('source_state')}
                AND publication."materializationVersion" = $3
                AND (
                  publication."sourceComputedAt" AT TIME ZONE 'Europe/Paris'
                )::date = $4::date
                AND publication."status" IN (
                  'building', 'validated', 'candidate'
                )
            ) current_publication ON true
            LEFT JOIN LATERAL (
              SELECT MAX(instance."heartbeatAt") AS "latestHeartbeatAt"
              FROM "zone_publication_instance" instance
              JOIN "zone_publication" candidate
                ON candidate."id" = publication_state."candidatePublicationId"
               AND candidate."sourceRevision" = ${sourceRevisionColumn('source_state')}
               AND candidate."materializationVersion" = $3
               AND (
                 candidate."sourceComputedAt" AT TIME ZONE 'Europe/Paris'
               )::date = $4::date
              WHERE instance."candidatePublicationId" = candidate."id"
            ) candidate_instances ON true
            LEFT JOIN LATERAL (
              SELECT run."updatedAt"
              FROM "external_publication_run" run
              WHERE run."jobKey" IN (
                  'compute:national-daily', 'compute:historic-catchup'
                )
                AND run."scheduledFor" = $4::date
                AND run."status" = 'running'
                AND run."metadata" @> jsonb_build_object(
                  'sourceRevision', ${sourceRevisionColumn('source_state')}::text,
                  'materializationVersion', $3
                )
              ORDER BY run."updatedAt" DESC
              LIMIT 1
            ) current_run ON true
            WHERE source_state."id" = 1
          `,
          [
            now,
            leaseSeconds,
            ZONE_PUBLICATION_MATERIALIZATION_VERSION,
            businessDate,
            requiredHistoricThrough,
          ],
        ),
        this.clockHeartbeat.getHealthStatus(now),
      ]);
      if (!state) {
        return unavailable();
      }

      const enabled = isZonePublicationEnabled();
      const automaticPublishing = state.automaticPublishingPaused !== true;
      const clockHealthy = clock.status === 'healthy';
      const liveInstances = Number(state.liveInstances || 0);
      const activeReadyInstances = Number(state.activeReadyInstances || 0);
      const activeServing =
        state.activeStatus === 'active' &&
        liveInstances >= minimumReadyInstances &&
        activeReadyInstances === liveInstances;
      const activeCurrent =
        activeServing &&
        String(state.activeSourceRevision ?? '') ===
          String(state.sourceRevision ?? '') &&
        Number(state.activeMaterializationVersion) ===
          ZONE_PUBLICATION_MATERIALIZATION_VERSION &&
        state.activeBusinessDate === businessDate;
      const candidateClear = state.hasCandidate !== true;
      const legacyPromotion = Boolean(state.legacyPromotedAt);
      const currentStatistics = state.currentPublishedDate === businessDate;
      const currentSnapshot = state.currentSnapshot === true;
      const certifiedHistoricRepair =
        state.certifiedHistoricRepair === true &&
        typeof state.certifiedHistoricThrough === 'string' &&
        typeof state.historicDirtyThrough === 'string' &&
        state.certifiedHistoricThrough >= state.historicDirtyThrough;
      const historicStatistics =
        (typeof state.historicPublishedThrough === 'string' &&
          state.historicPublishedThrough >= requiredHistoricThrough) ||
        certifiedHistoricRepair;
      const historicClean =
        !state.historicDirtyFrom && !state.historicDirtyThrough;
      const historicCursors =
        typeof state.computeMapDate === 'string' &&
        state.computeMapDate >= requiredHistoricThrough &&
        typeof state.computeStatsDate === 'string' &&
        state.computeStatsDate >= requiredHistoricThrough;
      const certifiedRun = state.certifiedCurrentRun === true;
      const historicRun = state.certifiedHistoricRun === true;
      const snapshotsComplete =
        Number(state.incompleteSnapshotCount || 0) === 0;
      const historicComplete =
        historicStatistics &&
        historicClean &&
        historicCursors &&
        historicRun &&
        snapshotsComplete;
      const historicStatus: PublicZonePublicationHistoricStatus =
        historicComplete
          ? 'complete'
          : certifiedHistoricRepair
            ? 'certified'
            : 'incomplete';
      const candidateRequestedAt = this.toDate(state.candidateRequestedAt);
      const candidateHeartbeatAt =
        candidateRequestedAt &&
        now.getTime() - candidateRequestedAt.getTime() <=
          progressStaleAfterSeconds * 1000
          ? state.latestCandidateHeartbeatAt
          : null;
      const latestProgressAt = this.latestDate(
        state.sourceUpdatedAt,
        state.stateUpdatedAt,
        candidateRequestedAt,
        state.statisticStateUpdatedAt,
        state.latestSnapshotUpdatedAt,
        state.latestPublicationProgressAt,
        candidateHeartbeatAt,
        state.currentRunUpdatedAt,
        state.historicCursorProgressAt,
      );
      const progressAgeMs = latestProgressAt
        ? now.getTime() - latestProgressAt.getTime()
        : null;
      const recentProgress =
        progressAgeMs !== null &&
        progressAgeMs >= -60 * 1000 &&
        progressAgeMs <= progressStaleAfterSeconds * 1000;

      const checks: PublicZonePublicationHealthChecks = {
        enabled,
        automaticPublishing,
        clock: clockHealthy,
        activeServing,
        activeCurrent,
        candidateClear,
        legacyPromotion,
        currentStatistics,
        currentSnapshot,
        historicStatistics,
        certifiedHistoricRepair,
        historicClean,
        historicCursors,
        certifiedRun,
        historicRun,
        snapshotsComplete,
        recentProgress,
      };
      const healthy =
        enabled &&
        automaticPublishing &&
        clockHealthy &&
        activeCurrent &&
        candidateClear &&
        legacyPromotion &&
        currentStatistics &&
        currentSnapshot &&
        certifiedRun;
      if (healthy) {
        return {
          status: 'healthy',
          historicStatus,
          serving: true,
          businessDate,
          requiredHistoricThrough,
          checks,
        };
      }

      const updating =
        enabled &&
        automaticPublishing &&
        clockHealthy &&
        activeServing &&
        recentProgress;
      return {
        status: updating ? 'updating' : 'stale',
        historicStatus,
        serving: activeServing,
        businessDate,
        requiredHistoricThrough,
        checks,
      };
    } catch {
      return unavailable();
    }
  }

  private latestDate(...values: unknown[]): Date | null {
    let latest: Date | null = null;
    for (const value of values) {
      const date = this.toDate(value);
      if (!date) {
        continue;
      }
      if (!latest || date > latest) {
        latest = date;
      }
    }
    return latest;
  }

  private toDate(value: unknown): Date | null {
    if (!value) {
      return null;
    }
    const date = new Date(value as string | number | Date);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private readPositiveInteger(key: string, fallback: number): number {
    const value = Number(this.configService.get<string>(key));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
}
