import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  getCivilDateAtUtcNoon,
  NATIONAL_DAILY_COMPUTE_JOB_KEY,
} from '../core/scheduling/daily-job-schedule';
import { readStatisticCachePositiveInteger } from '../statistic_cache/statistic_cache.config';
import {
  ActiveZonePublicationGate,
  ZonePublicationService,
} from '../zone_publication/zone_publication.service';
import { ZONE_PUBLICATION_MATERIALIZATION_VERSION } from '../zone_publication/zone_publication.config';
import { ExternalPublicationRegistryService } from './external-publication-registry.service';

const HISTORIC_FIRST_DATE = '2013-01-01';
const EXPECTED_ARTIFACT_COUNT = 3;
const EXPECTED_COMMUNE_COUNT = 34_943;
const EXPECTED_DEPARTMENT_COUNT = 101;

export type HistoricExportBlocker =
  | 'zone_publication_not_ready'
  | 'zone_publication_promotion_retry'
  | 'current_daily_not_ready'
  | 'statistic_cache_not_ready'
  | 'statistic_cache_outdated'
  | 'statistic_cache_quorum_incomplete'
  | 'sparse_statistic_cache'
  | 'historic_coverage_incomplete'
  | 'incomplete_snapshot'
  | 'certified_repair_not_active'
  | 'certified_repair_mismatch'
  | 'post_repair_snapshot_missing';

export interface HistoricExportReadinessIdentity {
  publicationMode: 'versioned';
  publicationId: string;
  sourceRevision: string;
  materializationVersion: number;
  statisticCachePublicationId: string;
  statisticRevision: string;
  statisticPublishedDate: string;
  statisticFingerprint: string;
  historicFirstDate: string;
  historicLatestDate: string;
  historicDateCount: number;
  historicComputeEpoch: string;
  historicReadinessMode: 'clean' | 'certified-repair';
  certifiedHistoryRepairId?: string;
  certifiedHistoryRepairAttestationId?: string;
}

export type HistoricExportReadiness =
  | {
      status: 'ready';
      scheduledFor: string;
      identity: HistoricExportReadinessIdentity;
    }
  | {
      status: 'blocked';
      scheduledFor: string;
      blocker: HistoricExportBlocker;
      details?: Record<string, string | number | boolean | null>;
    };

export type HistoricExportHealth = HistoricExportReadiness & {
  observedAt: string;
  blockingSince: string | null;
  blockingAgeSeconds: number;
};

interface StatisticBoundaryRow {
  publicationId: string;
  mode: string;
  materializationStrategy: string;
  schemaVersion: string | number;
  protocolVersion: string | number;
  statisticRevision: string | number;
  currentPublishedDate: string | Date;
  contentFingerprint: string;
  firstDate: string | Date;
  latestDate: string | Date;
  dateCount: string | number;
  communeCount: string | number;
  departmentCount: string | number;
  sourceRevision: string | number | null;
  historicComputeEpoch: string | number | null;
  certifiedHistoryRepairId: string | null;
  artifactHistoricDirtyFrom: string | Date | null;
  artifactHistoricDirtyThrough: string | Date | null;
  stateRevision: string | number;
  stateCurrentPublishedDate: string | Date | null;
  stateHistoricDirtyFrom: string | Date | null;
  stateHistoricDirtyThrough: string | Date | null;
  historicPublishedThrough: string | Date | null;
  computeMapDate: string | Date | null;
  computeStatsDate: string | Date | null;
  currentHistoricComputeEpoch: string | number;
  historicRecoveryMonthlyFrom: string | Date | null;
  artifactCount: string | number;
  liveInstances: string | number;
  readyInstances: string | number;
}

interface ActiveCertifiedRepairRow {
  id: string;
  dateFrom: string | Date;
  dateThrough: string | Date;
  activationKind: string;
  attestationId: string;
  currentHistoricComputeEpoch: string | number;
}

@Injectable()
export class HistoricExportReadinessService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly zonePublicationService: ZonePublicationService,
    private readonly registry: ExternalPublicationRegistryService,
  ) {}

  async getHealthStatus(
    scheduledFor: string,
    now = new Date(),
  ): Promise<HistoricExportHealth> {
    const readiness = await this.evaluate(scheduledFor);
    if (readiness.status === 'ready') {
      return {
        ...readiness,
        observedAt: now.toISOString(),
        blockingSince: null,
        blockingAgeSeconds: 0,
      };
    }
    const blockingSince = await this.readBlockingSince(scheduledFor);
    return {
      ...readiness,
      observedAt: now.toISOString(),
      blockingSince: blockingSince.toISOString(),
      blockingAgeSeconds: Math.max(
        0,
        Math.floor((now.getTime() - blockingSince.getTime()) / 1_000),
      ),
    };
  }

  async evaluate(
    scheduledFor: string,
    expectedZoneGate?: ActiveZonePublicationGate,
  ): Promise<HistoricExportReadiness> {
    getCivilDateAtUtcNoon(scheduledFor);
    const zoneGate =
      expectedZoneGate ??
      (await this.zonePublicationService.getActivePublicationGate(
        scheduledFor,
      ));
    if (!zoneGate) {
      return {
        status: 'blocked',
        scheduledFor,
        blocker: (await this.hasPromotionFailure())
          ? 'zone_publication_promotion_retry'
          : 'zone_publication_not_ready',
      };
    }

    const currentComputed = await this.registry.hasSucceeded(
      NATIONAL_DAILY_COMPUTE_JOB_KEY,
      scheduledFor,
      {
        sourceRevision: zoneGate.sourceRevision,
        materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
      },
    );
    if (!currentComputed) {
      return {
        status: 'blocked',
        scheduledFor,
        blocker: 'current_daily_not_ready',
      };
    }

    const boundary = await this.readStatisticBoundary(scheduledFor);
    if (!boundary) {
      return {
        status: 'blocked',
        scheduledFor,
        blocker: 'statistic_cache_not_ready',
      };
    }

    const sourceRevision = this.text(boundary.sourceRevision);
    const publishedDate = this.date(boundary.currentPublishedDate);
    const latestDate = this.date(boundary.latestDate);
    const statePublishedDate = this.date(boundary.stateCurrentPublishedDate);
    if (
      boundary.mode !== 'versioned' ||
      Number(boundary.schemaVersion) !== 1 ||
      Number(boundary.protocolVersion) !== 1 ||
      publishedDate !== scheduledFor ||
      latestDate !== scheduledFor ||
      statePublishedDate !== scheduledFor ||
      sourceRevision !== zoneGate.sourceRevision ||
      String(boundary.statisticRevision) !== String(boundary.stateRevision) ||
      String(boundary.historicComputeEpoch ?? '') !==
        String(boundary.currentHistoricComputeEpoch ?? '') ||
      boundary.historicRecoveryMonthlyFrom !== null
    ) {
      return {
        status: 'blocked',
        scheduledFor,
        blocker: 'statistic_cache_outdated',
      };
    }

    const minimumReadyInstances = readStatisticCachePositiveInteger(
      'STATISTIC_CACHE_MIN_READY_INSTANCES',
      2,
    );
    const liveInstances = Number(boundary.liveInstances);
    const readyInstances = Number(boundary.readyInstances);
    if (
      Number(boundary.artifactCount) !== EXPECTED_ARTIFACT_COUNT ||
      liveInstances < minimumReadyInstances ||
      readyInstances !== liveInstances
    ) {
      return {
        status: 'blocked',
        scheduledFor,
        blocker: 'statistic_cache_quorum_incomplete',
        details: {
          artifactCount: Number(boundary.artifactCount),
          liveInstances,
          readyInstances,
          minimumReadyInstances,
        },
      };
    }

    if (boundary.materializationStrategy === 'sparse-current') {
      return {
        status: 'blocked',
        scheduledFor,
        blocker: 'sparse_statistic_cache',
      };
    }

    const firstDate = this.date(boundary.firstDate);
    const expectedDayCount = this.dayCount(HISTORIC_FIRST_DATE, scheduledFor);
    if (
      firstDate !== HISTORIC_FIRST_DATE ||
      Number(boundary.dateCount) !== expectedDayCount ||
      Number(boundary.communeCount) !== EXPECTED_COMMUNE_COUNT ||
      Number(boundary.departmentCount) !== EXPECTED_DEPARTMENT_COUNT
    ) {
      return {
        status: 'blocked',
        scheduledFor,
        blocker: 'historic_coverage_incomplete',
        details: {
          firstDate,
          latestDate,
          dateCount: Number(boundary.dateCount),
          expectedDayCount,
          communeCount: Number(boundary.communeCount),
          departmentCount: Number(boundary.departmentCount),
        },
      };
    }

    const commonIdentity = {
      publicationMode: 'versioned' as const,
      publicationId: zoneGate.publicationId,
      sourceRevision: zoneGate.sourceRevision,
      materializationVersion: ZONE_PUBLICATION_MATERIALIZATION_VERSION,
      statisticCachePublicationId: String(boundary.publicationId),
      statisticRevision: String(boundary.statisticRevision),
      statisticPublishedDate: publishedDate!,
      statisticFingerprint: String(boundary.contentFingerprint),
      historicFirstDate: firstDate!,
      historicLatestDate: latestDate!,
      historicDateCount: Number(boundary.dateCount),
      historicComputeEpoch: String(boundary.historicComputeEpoch),
    };
    const dirtyFrom = this.date(boundary.stateHistoricDirtyFrom);
    const dirtyThrough = this.date(boundary.stateHistoricDirtyThrough);

    if (dirtyFrom === null && dirtyThrough === null) {
      const requiredHistoricThrough = this.previousDate(scheduledFor);
      if (
        this.date(boundary.artifactHistoricDirtyFrom) !== null ||
        this.date(boundary.artifactHistoricDirtyThrough) !== null ||
        boundary.certifiedHistoryRepairId !== null ||
        !this.dateAtLeast(
          boundary.historicPublishedThrough,
          requiredHistoricThrough,
        ) ||
        !this.dateAtLeast(boundary.computeMapDate, requiredHistoricThrough) ||
        !this.dateAtLeast(boundary.computeStatsDate, requiredHistoricThrough)
      ) {
        return {
          status: 'blocked',
          scheduledFor,
          blocker: 'historic_coverage_incomplete',
        };
      }
      const missingCurrentSnapshot = await this.countMissingPostRepairSnapshots(
        requiredHistoricThrough,
        scheduledFor,
        zoneGate.sourceRevision,
      );
      if (missingCurrentSnapshot > 0) {
        return {
          status: 'blocked',
          scheduledFor,
          blocker: 'incomplete_snapshot',
          details: { missingSnapshotCount: missingCurrentSnapshot },
        };
      }
      return {
        status: 'ready',
        scheduledFor,
        identity: {
          ...commonIdentity,
          historicReadinessMode: 'clean',
        },
      };
    }

    if (
      dirtyFrom === null ||
      dirtyThrough === null ||
      boundary.materializationStrategy !== 'certified-history-overlay' ||
      !boundary.certifiedHistoryRepairId
    ) {
      return {
        status: 'blocked',
        scheduledFor,
        blocker: 'certified_repair_not_active',
      };
    }
    if (
      this.date(boundary.artifactHistoricDirtyFrom) !== dirtyFrom ||
      this.date(boundary.artifactHistoricDirtyThrough) !== dirtyThrough
    ) {
      return {
        status: 'blocked',
        scheduledFor,
        blocker: 'certified_repair_mismatch',
      };
    }

    const repair = await this.readActiveCertifiedRepair(
      boundary.certifiedHistoryRepairId,
      dirtyFrom,
      dirtyThrough,
    );
    if (!repair) {
      return {
        status: 'blocked',
        scheduledFor,
        blocker: 'certified_repair_not_active',
      };
    }
    if (
      repair.activationKind !== 'statistics-only' ||
      this.date(repair.dateFrom) !== dirtyFrom ||
      this.date(repair.dateThrough) !== dirtyThrough ||
      String(repair.currentHistoricComputeEpoch) !==
        String(boundary.currentHistoricComputeEpoch)
    ) {
      return {
        status: 'blocked',
        scheduledFor,
        blocker: 'certified_repair_mismatch',
      };
    }

    const missingPostRepairSnapshots =
      await this.countMissingPostRepairSnapshots(
        dirtyThrough,
        scheduledFor,
        zoneGate.sourceRevision,
      );
    if (missingPostRepairSnapshots > 0) {
      return {
        status: 'blocked',
        scheduledFor,
        blocker: 'post_repair_snapshot_missing',
        details: { missingSnapshotCount: missingPostRepairSnapshots },
      };
    }

    return {
      status: 'ready',
      scheduledFor,
      identity: {
        ...commonIdentity,
        historicReadinessMode: 'certified-repair',
        certifiedHistoryRepairId: String(repair.id),
        certifiedHistoryRepairAttestationId: String(repair.attestationId),
      },
    };
  }

  async assertReady(expected: HistoricExportReadinessIdentity): Promise<void> {
    const current = await this.evaluate(expected.statisticPublishedDate);
    if (
      current.status !== 'ready' ||
      !Object.entries(expected).every(
        ([key, value]) =>
          current.identity[key as keyof HistoricExportReadinessIdentity] ===
          value,
      )
    ) {
      const blocker =
        current.status === 'blocked' ? ` (${current.blocker})` : '';
      throw new Error(
        `Historic export boundary changed for ${expected.statisticPublishedDate}/${expected.sourceRevision}${blocker}`,
      );
    }
  }

  private async hasPromotionFailure(): Promise<boolean> {
    const [row] = await this.dataSource.query(`
      SELECT publication."promotionError" IS NOT NULL AS "promotionFailed"
      FROM "zone_publication_state" state
      JOIN "zone_publication" publication
        ON publication."id" = state."activePublicationId"
      WHERE state."id" = 1
        AND publication."status" = 'active'
        AND publication."dataGouvPromotedAt" IS NULL
      LIMIT 1
    `);
    return row?.promotionFailed === true;
  }

  private async readBlockingSince(scheduledFor: string): Promise<Date> {
    const rows = await this.dataSource.query(
      `
        SELECT GREATEST(
          ($1::date + time '06:00') AT TIME ZONE 'Europe/Paris',
          COALESCE(
            (
              SELECT source."updatedAt"
              FROM "zone_publication_source_state" source
              WHERE source."id" = 1
            ),
            ($1::date + time '06:00') AT TIME ZONE 'Europe/Paris'
          )
        ) AS "blockingSince"
      `,
      [scheduledFor],
    );
    const value = Array.isArray(rows) ? rows[0]?.blockingSince : null;
    const parsed = value
      ? new Date(value)
      : getCivilDateAtUtcNoon(scheduledFor);
    if (Number.isNaN(parsed.getTime())) {
      return getCivilDateAtUtcNoon(scheduledFor);
    }
    return parsed;
  }

  private async readStatisticBoundary(
    scheduledFor: string,
  ): Promise<StatisticBoundaryRow | null> {
    const leaseSeconds = readStatisticCachePositiveInteger(
      'STATISTIC_CACHE_INSTANCE_LEASE_SECONDS',
      30,
    );
    const [row] = (await this.dataSource.query(
      `
        SELECT
          publication."id"::text AS "publicationId",
          publication."mode",
          publication."materializationStrategy",
          publication."schemaVersion",
          publication."protocolVersion",
          publication."statisticRevision",
          publication."currentPublishedDate",
          publication."contentFingerprint",
          publication."firstDate",
          publication."latestDate",
          publication."dateCount",
          publication."communeCount",
          publication."departmentCount",
          publication."sourceRevision",
          publication."historicComputeEpoch",
          publication."certifiedHistoryRepairId"::text
            AS "certifiedHistoryRepairId",
          publication."historicDirtyFrom" AS "artifactHistoricDirtyFrom",
          publication."historicDirtyThrough" AS "artifactHistoricDirtyThrough",
          statistic_state."revision" AS "stateRevision",
          statistic_state."currentPublishedDate" AS "stateCurrentPublishedDate",
          statistic_state."historicDirtyFrom" AS "stateHistoricDirtyFrom",
          statistic_state."historicDirtyThrough" AS "stateHistoricDirtyThrough",
          statistic_state."historicPublishedThrough",
          config."computeMapDate",
          config."computeStatsDate",
          config."historicComputeEpoch" AS "currentHistoricComputeEpoch",
          cache_state."historicRecoveryMonthlyFrom",
          (
            SELECT COUNT(*)::integer
            FROM "statistic_cache_artifact" artifact
            WHERE artifact."publicationId" = publication."id"
          ) AS "artifactCount",
          (
            SELECT COUNT(*)::integer
            FROM "zone_publication_instance" instance
            WHERE instance."heartbeatAt" >=
              now() - ($2 * interval '1 second')
          ) AS "liveInstances",
          (
            SELECT COUNT(*)::integer
            FROM "zone_publication_instance" instance
            WHERE instance."heartbeatAt" >=
                    now() - ($2 * interval '1 second')
              AND instance."statisticCachePublicationId" = publication."id"
              AND instance."statisticRevision" = publication."statisticRevision"
              AND instance."statisticPublishedDate" =
                    publication."currentPublishedDate"
              AND instance."statisticFingerprint" =
                    publication."contentFingerprint"
              AND instance."statisticLastError" IS NULL
          ) AS "readyInstances"
        FROM "statistic_cache_state" cache_state
        JOIN "statistic_cache_publication" publication
          ON publication."id" = cache_state."activePublicationId"
         AND publication."status" = 'active'
        JOIN "statistic_publication_state" statistic_state
          ON statistic_state."id" = 1
        JOIN "config" config ON config."id" = 1
        WHERE cache_state."id" = 1
          AND publication."currentPublishedDate" = $1::date
        LIMIT 1
      `,
      [scheduledFor, leaseSeconds],
    )) as StatisticBoundaryRow[];
    return row ?? null;
  }

  // This is the sole coupling point with certified-history validity. The view
  // is fail-closed: a revoked, unattested or partially tagged repair is absent.
  private async readActiveCertifiedRepair(
    repairId: string,
    dateFrom: string,
    dateThrough: string,
  ): Promise<ActiveCertifiedRepairRow | null> {
    const [row] = (await this.dataSource.query(
      `
        SELECT
          repair."id"::text AS "id",
          repair."dateFrom",
          repair."dateThrough",
          repair."activationKind",
          repair."attestationId"::text AS "attestationId",
          repair."currentHistoricComputeEpoch"
        FROM "active_certified_history_repair" repair
        WHERE repair."id" = $1::uuid
          AND repair."dateFrom" = $2::date
          AND repair."dateThrough" = $3::date
          AND repair."activationKind" = 'statistics-only'
        LIMIT 1
      `,
      [repairId, dateFrom, dateThrough],
    )) as ActiveCertifiedRepairRow[];
    return row ?? null;
  }

  private async countMissingPostRepairSnapshots(
    repairThrough: string,
    scheduledFor: string,
    sourceRevision: string,
  ): Promise<number> {
    const [row] = await this.dataSource.query(
      `
        WITH required_date AS (
          SELECT value::date AS "snapshotDate"
          FROM generate_series(
            $1::date + interval '1 day',
            $2::date,
            interval '1 day'
          ) value
          UNION
          SELECT $2::date AS "snapshotDate"
        )
        SELECT COUNT(*)::integer AS "missingSnapshotCount"
        FROM required_date required
        WHERE NOT EXISTS (
          SELECT 1
          FROM "statistic_commune_snapshot" snapshot
          WHERE snapshot."snapshotDate" = required."snapshotDate"
            AND snapshot."scope" = 'national'
            AND snapshot."status" = 'completed'
            AND snapshot."expectedCommuneCount" = $4
            AND snapshot."processedCommuneCount" = $4
            AND (
              required."snapshotDate" <> $2::date
              OR snapshot."sourceRevision" = $3::bigint
            )
        )
      `,
      [repairThrough, scheduledFor, sourceRevision, EXPECTED_COMMUNE_COUNT],
    );
    return Number(row?.missingSnapshotCount ?? 0);
  }

  private text(value: unknown): string | null {
    return value === null || value === undefined ? null : String(value);
  }

  private date(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
  }

  private dayCount(dateFrom: string, dateThrough: string): number {
    const from = getCivilDateAtUtcNoon(dateFrom).getTime();
    const through = getCivilDateAtUtcNoon(dateThrough).getTime();
    return Math.floor((through - from) / 86_400_000) + 1;
  }

  private previousDate(value: string): string {
    const date = getCivilDateAtUtcNoon(value);
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }

  private dateAtLeast(value: unknown, minimum: string): boolean {
    const date = this.date(value);
    return date !== null && date >= minimum;
  }
}
