import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { S3Service } from '../shared/services/s3.service';
import { unwrapTypeOrmDmlReturningRows } from '../zone_publication/typeorm-query-result';
import { HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT } from './historic-backfill-queue.service';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STATISTIC_COMMUNE_LOCK = 'vigieau:statistic-commune:snapshot-computation';
export const HISTORIC_BACKFILL_PUBLIC_MAP_MANIFEST_KEY =
  'pmtiles/historic-backfill-manifest.json';
const HISTORIC_BACKFILL_PUBLIC_MAP_MANIFEST_FILE =
  'historic-backfill-manifest.json';
const HISTORIC_BACKFILL_PUBLIC_MAP_MANIFEST_PREFIX = 'pmtiles/';
const HISTORIC_BACKFILL_MAP_MANIFEST_PUBLICATION_LOCK =
  'historic-backfill-map-manifest-publication';
export const HISTORIC_BACKFILL_ARTIFACT_HEAD_CONCURRENCY_DEFAULT = 16;
export const HISTORIC_BACKFILL_ARTIFACT_HEAD_CONCURRENCY_MAX = 32;
export const HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS_DEFAULT = 60_000;
export const HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS_MIN = 1_000;
export const HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS_MAX = 600_000;

export function readHistoricBackfillArtifactHeadConcurrency(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const raw = environment.HISTORIC_BACKFILL_ARTIFACT_HEAD_CONCURRENCY?.trim();
  const concurrency = raw
    ? Number(raw)
    : HISTORIC_BACKFILL_ARTIFACT_HEAD_CONCURRENCY_DEFAULT;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > HISTORIC_BACKFILL_ARTIFACT_HEAD_CONCURRENCY_MAX
  ) {
    throw new Error(
      'HISTORIC_BACKFILL_ARTIFACT_HEAD_CONCURRENCY must be between 1 and 32',
    );
  }
  return concurrency;
}

export function readHistoricBackfillManifestUploadTimeout(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const raw = environment.HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS?.trim();
  const timeoutMs = raw
    ? Number(raw)
    : HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS_DEFAULT;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS_MIN ||
    timeoutMs > HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS_MAX
  ) {
    throw new Error(
      'HISTORIC_BACKFILL_MANIFEST_UPLOAD_TIMEOUT_MS must be between 1000 and 600000',
    );
  }
  return timeoutMs;
}

interface Queryable {
  query(query: string, parameters?: unknown[]): Promise<unknown>;
}

interface HistoricBackfillMapContextRow {
  id: string;
  status: string;
  mapDateFrom: string | Date;
  statisticDateFrom: string | Date;
  dateThrough: string | Date;
  sourceRevision: string | number;
  currentSourceRevision: string | number;
  historicComputeEpoch: string | number;
  currentHistoricComputeEpoch: string | number;
  historicBackfillGlobalEpoch: string | number;
  currentHistoricBackfillGlobalEpoch: string | number;
  statisticsPromotedAt: string | Date | null;
  computeMapDate: string | Date | null;
  computeMapGeneration: string | number;
  computeStatsDate: string | Date | null;
  historicPublishedThrough: string | Date | null;
  historicDirtyFrom: string | Date | null;
  historicDirtyThrough: string | Date | null;
  departmentTaskCount: string | number;
  currentDepartmentTaskCount: string | number;
  currentQueueCount: string | number;
  runningSnapshotCount: string | number;
  runningDailyCount: string | number;
}

interface HistoricBackfillArtifactRow {
  validFrom: string | Date;
  validThrough: string | Date;
  sourceRevision: string | number;
  historicComputeEpoch: string | number;
  status: string;
  geojsonObjectKey: string | null;
  geojsonChecksum: string | null;
  pmtilesObjectKey: string | null;
  pmtilesChecksum: string | null;
  featureCount: string | number;
}

interface HistoricBackfillArtifact {
  validFrom: string;
  validThrough: string;
  geojsonObjectKey: string;
  geojsonChecksum: string;
  pmtilesObjectKey: string;
  pmtilesChecksum: string;
  featureCount: number;
}

interface HistoricBackfillMapPlan {
  runId: string;
  mapDateFrom: string;
  dateThrough: string;
  sourceRevision: string;
  historicComputeEpoch: string;
  historicBackfillGlobalEpoch: string;
  computeMapGeneration: string;
  artifacts: HistoricBackfillArtifact[];
  dayCount: number;
}

interface HistoricBackfillPublicMapManifest {
  version: 1;
  runId: string;
  mapDateFrom: string;
  dateThrough: string;
  sourceRevision: string;
  historicComputeEpoch: string;
  artifacts: Array<{
    validFrom: string;
    validThrough: string;
    geojsonUrl: string;
    geojsonChecksum: string;
    pmtilesUrl: string;
    pmtilesChecksum: string;
    featureCount: number;
  }>;
}

interface HistoricBackfillMapPublicationRow {
  runId: string;
  status: string;
  mapDateFrom: string | Date;
  dateThrough: string | Date;
  sourceRevision: string | number;
  historicComputeEpoch: string | number;
  mapGeneration: string | number;
  statisticRevision: string | number;
  artifactTaskCount: string | number;
  dayCount: string | number;
  manifestObjectKey: string;
  manifestBody: string;
  manifestChecksum: string;
  publishedAt: string | Date | null;
}

interface HistoricBackfillMapPublication {
  runId: string;
  status: 'pending' | 'published';
  mapDateFrom: string;
  dateThrough: string;
  sourceRevision: string;
  historicComputeEpoch: string;
  mapGeneration: string;
  statisticRevision: string;
  artifactTaskCount: number;
  dayCount: number;
  manifestObjectKey: string;
  manifestBody: string;
  manifestChecksum: string;
  publishedAt: string | Date | null;
}

interface CurrentPriorityRow {
  currentQueueCount: string | number;
  runningSnapshotCount: string | number;
  runningDailyCount: string | number;
  statisticsPromotedCount: string | number;
}

export interface HistoricBackfillMapFinalizationResult {
  runId: string;
  mode: 'dry-run' | 'applied';
  mapDateFrom: string;
  dateThrough: string;
  artifactTaskCount: number;
  dayCount: number;
  copiedObjectCount: number;
  verifiedObjectCount: number;
  manifestObjectKey: string;
  mapGeneration: string;
  statisticRevision?: string;
}

function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new Error('runId must be a UUID');
  }
}

function toCivilDate(value: string | Date | null, name: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized =
    value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value).slice(0, 10);
  if (!CIVIL_DATE_PATTERN.test(normalized)) {
    throw new Error(`${name} is not a civil date`);
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
  ) {
    throw new Error(`${name} is not a valid civil date`);
  }
  return normalized;
}

function nextCivilDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function inclusiveDayCount(from: string, through: string): number {
  const fromTime = Date.parse(`${from}T00:00:00.000Z`);
  const throughTime = Date.parse(`${through}T00:00:00.000Z`);
  return Math.floor((throughTime - fromTime) / 86_400_000) + 1;
}

function count(value: string | number, name: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${name} is not a non-negative integer`);
  }
  return normalized;
}

function incrementBigInt(value: string): string {
  if (!/^\d+$/.test(value)) {
    throw new Error('computeMapGeneration is invalid');
  }
  return (BigInt(value) + 1n).toString();
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class HistoricBackfillMapFinalizerService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly s3Service: S3Service,
  ) {}

  dryRun(runId: string): Promise<HistoricBackfillMapFinalizationResult> {
    return this.finalize(runId, false);
  }

  apply(runId: string): Promise<HistoricBackfillMapFinalizationResult> {
    return this.finalize(runId, true);
  }

  async finalize(
    runId: string,
    apply = false,
  ): Promise<HistoricBackfillMapFinalizationResult> {
    assertUuid(runId);
    const existingPublication = await this.findPublication(
      this.dataSource,
      runId,
      false,
    );
    if (existingPublication) {
      const publication = this.normalizePublication(existingPublication);
      return apply
        ? this.publishPendingPublication(publication)
        : this.toResult(publication, 'dry-run');
    }

    const plan = await this.inspect(this.dataSource, runId, false);
    const nextMapGeneration = incrementBigInt(plan.computeMapGeneration);

    if (!apply) {
      return {
        runId,
        mode: 'dry-run',
        mapDateFrom: plan.mapDateFrom,
        dateThrough: plan.dateThrough,
        artifactTaskCount: plan.artifacts.length,
        dayCount: plan.dayCount,
        copiedObjectCount: 0,
        verifiedObjectCount: 0,
        manifestObjectKey: HISTORIC_BACKFILL_PUBLIC_MAP_MANIFEST_KEY,
        mapGeneration: nextMapGeneration,
      };
    }

    await this.verifyImmutableArtifacts(plan);
    const publication = await this.preparePublication(
      plan,
      nextMapGeneration,
      this.buildPublicManifest(plan),
    );
    return this.publishPendingPublication(publication);
  }

  private async inspect(
    queryable: Queryable,
    runId: string,
    lockContext: boolean,
  ): Promise<HistoricBackfillMapPlan> {
    const contextRows = (await queryable.query(
      `
        SELECT
          run."id",
          run."status",
          run."mapDateFrom"::text AS "mapDateFrom",
          run."statisticDateFrom"::text AS "statisticDateFrom",
          run."dateThrough"::text AS "dateThrough",
          run."sourceRevision"::text AS "sourceRevision",
          source_state."publicRevision"::text AS "currentSourceRevision",
          run."historicComputeEpoch"::text AS "historicComputeEpoch",
          config."historicComputeEpoch"::text
            AS "currentHistoricComputeEpoch",
          run."historicBackfillGlobalEpoch"::text
            AS "historicBackfillGlobalEpoch",
          config."historicBackfillGlobalEpoch"::text
            AS "currentHistoricBackfillGlobalEpoch",
          run."statisticsPromotedAt" AS "statisticsPromotedAt",
          config."computeMapDate"::text AS "computeMapDate",
          config."computeMapGeneration"::text AS "computeMapGeneration",
          config."computeStatsDate"::text AS "computeStatsDate",
          publication_state."historicPublishedThrough"::text
            AS "historicPublishedThrough",
          publication_state."historicDirtyFrom"::text AS "historicDirtyFrom",
          publication_state."historicDirtyThrough"::text
            AS "historicDirtyThrough",
          (
            SELECT COUNT(*)::integer
            FROM "historic_backfill_task" task
            WHERE task."runId" = run."id"
          ) AS "departmentTaskCount",
          (
            SELECT COUNT(*)::integer
            FROM "historic_backfill_task" task
            JOIN "historic_backfill_department_revision" revision
              ON revision."departementId" = task."departementId"
            WHERE task."runId" = run."id"
              AND task."status" = 'completed'
              AND task."departmentGeneration" = revision."generation"
          ) AS "currentDepartmentTaskCount",
          (
            SELECT COUNT(*)::integer
            FROM "current_zone_recompute_request" request
            WHERE request."currentPending"
              OR EXISTS (
                SELECT 1
                FROM unnest(request."pendingScheduledDates")
                  AS pending_dates(pending_date)
                WHERE pending_date <=
                  (now() AT TIME ZONE 'Europe/Paris')::date
              )
          ) AS "currentQueueCount",
          (
            SELECT COUNT(*)::integer
            FROM "statistic_commune_snapshot" snapshot
            WHERE snapshot."status" = 'running'
          ) AS "runningSnapshotCount",
          (
            SELECT COUNT(*)::integer
            FROM "external_publication_run" daily_run
            WHERE daily_run."jobKey" = 'compute:national-daily'
              AND daily_run."status" = 'running'
          ) AS "runningDailyCount"
        FROM "historic_backfill_run" run
        CROSS JOIN "zone_publication_source_state" source_state
        CROSS JOIN "config" config
        CROSS JOIN "statistic_publication_state" publication_state
        WHERE run."id" = $1::uuid
          AND source_state."id" = 1
          AND config."id" = 1
          AND publication_state."id" = 1
        ${
          lockContext
            ? 'FOR UPDATE OF run, source_state, config, publication_state'
            : ''
        }
      `,
      [runId],
    )) as HistoricBackfillMapContextRow[];
    const context = contextRows[0];
    if (!context) {
      throw new Error(
        'Historic backfill run or publication context is missing',
      );
    }

    const mapDateFrom = toCivilDate(context.mapDateFrom, 'run.mapDateFrom')!;
    const statisticDateFrom = toCivilDate(
      context.statisticDateFrom,
      'run.statisticDateFrom',
    )!;
    const dateThrough = toCivilDate(context.dateThrough, 'run.dateThrough')!;
    const computeStatsDate = toCivilDate(
      context.computeStatsDate,
      'config.computeStatsDate',
    );
    const historicPublishedThrough = toCivilDate(
      context.historicPublishedThrough,
      'publication.historicPublishedThrough',
    );
    const historicDirtyFrom = toCivilDate(
      context.historicDirtyFrom,
      'publication.historicDirtyFrom',
    );
    const historicDirtyThrough = toCivilDate(
      context.historicDirtyThrough,
      'publication.historicDirtyThrough',
    );
    const sourceRevision = String(context.sourceRevision);
    const historicComputeEpoch = String(context.historicComputeEpoch);
    const historicBackfillGlobalEpoch = String(
      context.historicBackfillGlobalEpoch,
    );

    if (context.status !== 'running') {
      throw new Error('Historic backfill run is not running');
    }
    if (historicComputeEpoch !== String(context.currentHistoricComputeEpoch)) {
      throw new Error('Historic compute epoch changed');
    }
    if (
      historicBackfillGlobalEpoch !==
      String(context.currentHistoricBackfillGlobalEpoch)
    ) {
      throw new Error('Historic backfill global epoch changed');
    }
    if (sourceRevision !== String(context.currentSourceRevision)) {
      throw new Error('Historic source revision changed');
    }
    if (!context.statisticsPromotedAt) {
      throw new Error(
        'Historic statistics have not been promoted for this run',
      );
    }
    if (computeStatsDate === null || computeStatsDate < dateThrough) {
      throw new Error(
        `Historic statistic cursor must be at least ${dateThrough}`,
      );
    }
    if (
      historicDirtyFrom === null ||
      historicDirtyThrough === null ||
      historicDirtyFrom < mapDateFrom ||
      historicDirtyFrom < statisticDateFrom ||
      historicDirtyThrough > dateThrough ||
      (historicPublishedThrough !== null &&
        historicPublishedThrough > dateThrough)
    ) {
      throw new Error(
        'Historic statistic dirty range is not covered by the run',
      );
    }
    if (
      count(context.currentQueueCount, 'current queue count') !== 0 ||
      count(context.runningSnapshotCount, 'running snapshot count') !== 0 ||
      count(context.runningDailyCount, 'running daily count') !== 0
    ) {
      throw new Error('Current computation has priority over historic maps');
    }
    if (
      count(context.departmentTaskCount, 'department task count') !==
        HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT ||
      count(
        context.currentDepartmentTaskCount,
        'current department task count',
      ) !== HISTORIC_BACKFILL_EXPECTED_DEPARTMENT_COUNT
    ) {
      throw new Error(
        'Department backfill tasks are not all completed at their current generation',
      );
    }

    const artifactRows = (await queryable.query(
      `
        SELECT
          task."validFrom"::text AS "validFrom",
          task."validThrough"::text AS "validThrough",
          task."sourceRevision"::text AS "sourceRevision",
          task."historicComputeEpoch"::text AS "historicComputeEpoch",
          task."status",
          task."geojsonObjectKey",
          task."geojsonChecksum",
          task."pmtilesObjectKey",
          task."pmtilesChecksum",
          task."featureCount"
        FROM "historic_backfill_artifact_task" task
        WHERE task."runId" = $1::uuid
        ORDER BY task."validFrom"
        ${lockContext ? 'FOR UPDATE' : ''}
      `,
      [runId],
    )) as HistoricBackfillArtifactRow[];
    const artifacts = this.validateArtifacts(
      runId,
      mapDateFrom,
      dateThrough,
      sourceRevision,
      historicComputeEpoch,
      artifactRows,
    );

    return {
      runId,
      mapDateFrom,
      dateThrough,
      sourceRevision,
      historicComputeEpoch,
      historicBackfillGlobalEpoch,
      computeMapGeneration: String(context.computeMapGeneration),
      artifacts,
      dayCount: inclusiveDayCount(mapDateFrom, dateThrough),
    };
  }

  private validateArtifacts(
    runId: string,
    mapDateFrom: string,
    dateThrough: string,
    sourceRevision: string,
    historicComputeEpoch: string,
    rows: HistoricBackfillArtifactRow[],
  ): HistoricBackfillArtifact[] {
    if (rows.length === 0) {
      throw new Error('No completed national artifact task was found');
    }

    const prefix =
      `historic-backfill/${runId}/national/` +
      `revision-${sourceRevision}/epoch-${historicComputeEpoch}/`;
    let expectedFrom = mapDateFrom;
    const artifacts = rows.map((row, index) => {
      const validFrom = toCivilDate(
        row.validFrom,
        `artifact[${index}].validFrom`,
      )!;
      const validThrough = toCivilDate(
        row.validThrough,
        `artifact[${index}].validThrough`,
      )!;
      const featureCount = count(row.featureCount, 'artifact feature count');
      if (row.status !== 'completed') {
        throw new Error(`Historic artifact task ${validFrom} is not completed`);
      }
      if (
        String(row.sourceRevision) !== sourceRevision ||
        String(row.historicComputeEpoch) !== historicComputeEpoch
      ) {
        throw new Error(`Historic artifact task ${validFrom} is stale`);
      }
      if (validFrom !== expectedFrom || validThrough < validFrom) {
        throw new Error(
          `Historic artifact coverage is not contiguous at ${validFrom}`,
        );
      }
      if (
        !SHA256_PATTERN.test(row.geojsonChecksum ?? '') ||
        !SHA256_PATTERN.test(row.pmtilesChecksum ?? '')
      ) {
        throw new Error(
          `Historic artifact checksums are invalid for ${validFrom}`,
        );
      }
      if (
        row.geojsonObjectKey !==
          `${prefix}${validFrom}-${row.geojsonChecksum}.geojson` ||
        row.pmtilesObjectKey !==
          `${prefix}${validFrom}-${row.pmtilesChecksum}.pmtiles`
      ) {
        throw new Error(`Historic artifact keys are invalid for ${validFrom}`);
      }
      expectedFrom = nextCivilDate(validThrough);
      return {
        validFrom,
        validThrough,
        geojsonObjectKey: row.geojsonObjectKey,
        geojsonChecksum: row.geojsonChecksum,
        pmtilesObjectKey: row.pmtilesObjectKey,
        pmtilesChecksum: row.pmtilesChecksum,
        featureCount,
      };
    });

    if (artifacts[0].validFrom !== mapDateFrom) {
      throw new Error('Historic artifact coverage starts after mapDateFrom');
    }
    if (artifacts[artifacts.length - 1].validThrough !== dateThrough) {
      throw new Error('Historic artifact coverage does not reach dateThrough');
    }
    return artifacts;
  }

  private async findPublication(
    queryable: Queryable,
    runId: string,
    lock: boolean,
  ): Promise<HistoricBackfillMapPublicationRow | null> {
    const rows = (await queryable.query(
      `
        SELECT
          "runId",
          "status",
          "mapDateFrom"::text AS "mapDateFrom",
          "dateThrough"::text AS "dateThrough",
          "sourceRevision"::text AS "sourceRevision",
          "historicComputeEpoch"::text AS "historicComputeEpoch",
          "mapGeneration"::text AS "mapGeneration",
          "statisticRevision"::text AS "statisticRevision",
          "artifactTaskCount",
          "dayCount",
          "manifestObjectKey",
          "manifestBody",
          "manifestChecksum",
          "publishedAt"
        FROM "historic_backfill_map_manifest_outbox"
        WHERE "runId" = $1::uuid
        ${lock ? 'FOR UPDATE' : ''}
      `,
      [runId],
    )) as HistoricBackfillMapPublicationRow[];
    return rows[0] ?? null;
  }

  private normalizePublication(
    row: HistoricBackfillMapPublicationRow,
  ): HistoricBackfillMapPublication {
    const mapDateFrom = toCivilDate(row.mapDateFrom, 'outbox.mapDateFrom')!;
    const dateThrough = toCivilDate(row.dateThrough, 'outbox.dateThrough')!;
    const sourceRevision = String(row.sourceRevision);
    const historicComputeEpoch = String(row.historicComputeEpoch);
    const mapGeneration = String(row.mapGeneration);
    const statisticRevision = String(row.statisticRevision);
    const artifactTaskCount = count(
      row.artifactTaskCount,
      'outbox artifact task count',
    );
    const dayCount = count(row.dayCount, 'outbox day count');
    if (
      !UUID_PATTERN.test(row.runId) ||
      !['pending', 'published'].includes(row.status) ||
      !/^\d+$/.test(sourceRevision) ||
      !/^\d+$/.test(historicComputeEpoch) ||
      !/^\d+$/.test(mapGeneration) ||
      !/^\d+$/.test(statisticRevision) ||
      mapDateFrom > dateThrough ||
      dayCount !== inclusiveDayCount(mapDateFrom, dateThrough) ||
      artifactTaskCount < 1 ||
      row.manifestObjectKey !== HISTORIC_BACKFILL_PUBLIC_MAP_MANIFEST_KEY ||
      !SHA256_PATTERN.test(row.manifestChecksum) ||
      sha256(row.manifestBody) !== row.manifestChecksum ||
      (row.status === 'pending' && row.publishedAt !== null) ||
      (row.status === 'published' && row.publishedAt === null)
    ) {
      throw new Error('Historic map publication outbox row is invalid');
    }

    let manifest: HistoricBackfillPublicMapManifest;
    try {
      manifest = JSON.parse(
        row.manifestBody,
      ) as HistoricBackfillPublicMapManifest;
    } catch {
      throw new Error('Historic map publication manifest body is invalid');
    }
    if (
      manifest.version !== 1 ||
      manifest.runId !== row.runId ||
      manifest.mapDateFrom !== mapDateFrom ||
      manifest.dateThrough !== dateThrough ||
      manifest.sourceRevision !== sourceRevision ||
      manifest.historicComputeEpoch !== historicComputeEpoch ||
      !Array.isArray(manifest.artifacts) ||
      manifest.artifacts.length !== artifactTaskCount
    ) {
      throw new Error('Historic map publication manifest context is invalid');
    }

    return {
      runId: row.runId,
      status: row.status as 'pending' | 'published',
      mapDateFrom,
      dateThrough,
      sourceRevision,
      historicComputeEpoch,
      mapGeneration,
      statisticRevision,
      artifactTaskCount,
      dayCount,
      manifestObjectKey: row.manifestObjectKey,
      manifestBody: row.manifestBody,
      manifestChecksum: row.manifestChecksum,
      publishedAt: row.publishedAt,
    };
  }

  private async verifyImmutableArtifacts(
    plan: HistoricBackfillMapPlan,
  ): Promise<void> {
    const concurrency = readHistoricBackfillArtifactHeadConcurrency();
    const checks = plan.artifacts.flatMap((artifact) => [
      {
        validFrom: artifact.validFrom,
        objectKey: artifact.geojsonObjectKey,
      },
      {
        validFrom: artifact.validFrom,
        objectKey: artifact.pmtilesObjectKey,
      },
    ]);
    const controller = new AbortController();
    let nextIndex = 0;
    let failed = false;
    let primaryError: unknown;

    const verifyNext = async (): Promise<void> => {
      while (!failed) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= checks.length) return;
        const check = checks[index];
        try {
          const head = await this.s3Service.headFile(check.objectKey, '', {
            abortSignal: controller.signal,
          });
          if (Number(head.ContentLength ?? 0) <= 0) {
            throw new Error(
              `Immutable historic artifacts are empty for ${check.validFrom}`,
            );
          }
        } catch (error) {
          if (!failed) {
            failed = true;
            primaryError = error;
            controller.abort(error);
          }
          return;
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, checks.length) }, verifyNext),
    );
    if (failed) throw primaryError;
  }

  private buildPublicManifest(
    plan: HistoricBackfillMapPlan,
  ): HistoricBackfillPublicMapManifest {
    return {
      version: 1,
      runId: plan.runId,
      mapDateFrom: plan.mapDateFrom,
      dateThrough: plan.dateThrough,
      sourceRevision: plan.sourceRevision,
      historicComputeEpoch: plan.historicComputeEpoch,
      artifacts: plan.artifacts.map((artifact) => ({
        validFrom: artifact.validFrom,
        validThrough: artifact.validThrough,
        geojsonUrl: this.s3Service.getPublicFileUrl(artifact.geojsonObjectKey),
        geojsonChecksum: artifact.geojsonChecksum,
        pmtilesUrl: this.s3Service.getPublicFileUrl(artifact.pmtilesObjectKey),
        pmtilesChecksum: artifact.pmtilesChecksum,
        featureCount: artifact.featureCount,
      })),
    };
  }

  private async switchPublicManifest(manifestBody: string): Promise<void> {
    const abortSignal = AbortSignal.timeout(
      readHistoricBackfillManifestUploadTimeout(),
    );
    await this.s3Service.uploadFile(
      {
        originalname: HISTORIC_BACKFILL_PUBLIC_MAP_MANIFEST_FILE,
        mimetype: 'application/json',
        buffer: Buffer.from(manifestBody, 'utf8'),
      } as Express.Multer.File,
      HISTORIC_BACKFILL_PUBLIC_MAP_MANIFEST_PREFIX,
      {
        acl: 'public-read',
        cacheControl: 'public, max-age=0, must-revalidate',
        contentType: 'application/json',
        abortSignal,
      },
    );
  }

  private async preparePublication(
    expected: HistoricBackfillMapPlan,
    nextMapGeneration: string,
    manifest: HistoricBackfillPublicMapManifest,
  ): Promise<HistoricBackfillMapPublication> {
    const manifestBody = `${JSON.stringify(manifest)}\n`;
    const manifestChecksum = sha256(manifestBody);
    const queryRunner = this.dataSource.createQueryRunner();
    let zoneLockAcquired = false;
    let statisticLockAcquired = false;
    let transactionStarted = false;
    let primaryError: unknown = null;

    await queryRunner.connect();
    try {
      zoneLockAcquired = await this.tryAcquireZoneLock(queryRunner);
      if (!zoneLockAcquired) {
        throw new Error('Current zone computation has priority');
      }
      statisticLockAcquired = await this.tryAcquireStatisticLock(queryRunner);
      if (!statisticLockAcquired) {
        throw new Error('Current commune statistic computation has priority');
      }

      await queryRunner.startTransaction('SERIALIZABLE');
      transactionStarted = true;
      const existing = await this.findPublication(
        queryRunner,
        expected.runId,
        true,
      );
      if (existing) {
        const publication = this.normalizePublication(existing);
        await queryRunner.commitTransaction();
        transactionStarted = false;
        return publication;
      }

      const actual = await this.inspect(queryRunner, expected.runId, true);
      this.assertSamePlan(expected, actual);

      const configRows = unwrapTypeOrmDmlReturningRows<{
        computeMapGeneration: string | number;
      }>(
        await queryRunner.query(
          `
            UPDATE "config" config
            SET
              "computeMapDate" = GREATEST(
                COALESCE(config."computeMapDate", $1::date),
                $1::date
              ),
              "computeMapGeneration" = "computeMapGeneration" + 1,
              "computeMapUpdatedAt" = now()
            WHERE config."id" = 1
              AND config."computeStatsDate" >= $1::date
              AND config."historicComputeEpoch" = $2::bigint
              AND EXISTS (
                SELECT 1
                FROM "historic_backfill_run" run
                WHERE run."id" = $4::uuid
                  AND run."historicBackfillGlobalEpoch" =
                    config."historicBackfillGlobalEpoch"
              )
              AND EXISTS (
                SELECT 1
                FROM "zone_publication_source_state" source_state
                WHERE source_state."id" = 1
                  AND source_state."publicRevision" = $3::bigint
              )
              AND NOT EXISTS (
                SELECT 1
                FROM "current_zone_recompute_request" request
                WHERE request."currentPending"
                  OR EXISTS (
                    SELECT 1
                    FROM unnest(request."pendingScheduledDates")
                      AS pending_dates(pending_date)
                    WHERE pending_date <=
                      (now() AT TIME ZONE 'Europe/Paris')::date
                  )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM "statistic_commune_snapshot"
                WHERE "status" = 'running'
              )
              AND NOT EXISTS (
                SELECT 1
                FROM "external_publication_run" daily_run
                WHERE daily_run."jobKey" = 'compute:national-daily'
                  AND daily_run."status" = 'running'
              )
            RETURNING "computeMapGeneration"::text AS "computeMapGeneration"
          `,
          [
            expected.dateThrough,
            expected.historicComputeEpoch,
            expected.sourceRevision,
            expected.runId,
          ],
        ),
      );
      if (
        configRows.length !== 1 ||
        String(configRows[0].computeMapGeneration) !== nextMapGeneration
      ) {
        throw new Error('Historic map cursor promotion lost its context');
      }

      const publicationRows = unwrapTypeOrmDmlReturningRows<{
        revision: string | number;
      }>(
        await queryRunner.query(
          `
            UPDATE "statistic_publication_state"
            SET
              "revision" = "revision" + 1,
              "historicPublishedThrough" = $1::date,
              "historicDirtyFrom" = NULL,
              "historicDirtyThrough" = NULL,
              "updatedAt" = now()
            WHERE "id" = 1
              AND "historicDirtyFrom" IS NOT NULL
              AND "historicDirtyThrough" IS NOT NULL
              AND "historicDirtyThrough" <= $1::date
            RETURNING "revision"::text AS "revision"
          `,
          [expected.dateThrough],
        ),
      );
      if (publicationRows.length !== 1) {
        throw new Error('Historic statistic publication promotion failed');
      }

      const outboxRows =
        unwrapTypeOrmDmlReturningRows<HistoricBackfillMapPublicationRow>(
          await queryRunner.query(
            `
            INSERT INTO "historic_backfill_map_manifest_outbox" (
              "runId", "status", "mapDateFrom", "dateThrough",
              "sourceRevision", "historicComputeEpoch", "mapGeneration",
              "statisticRevision", "artifactTaskCount", "dayCount",
              "manifestObjectKey", "manifestBody", "manifestChecksum"
            )
            VALUES (
              $1::uuid, 'pending', $2::date, $3::date,
              $4::bigint, $5::bigint, $6::bigint,
              $7::bigint, $8::integer, $9::integer,
              $10, $11, $12
            )
            RETURNING
              "runId", "status",
              "mapDateFrom"::text AS "mapDateFrom",
              "dateThrough"::text AS "dateThrough",
              "sourceRevision"::text AS "sourceRevision",
              "historicComputeEpoch"::text AS "historicComputeEpoch",
              "mapGeneration"::text AS "mapGeneration",
              "statisticRevision"::text AS "statisticRevision",
              "artifactTaskCount", "dayCount", "manifestObjectKey",
              "manifestBody", "manifestChecksum", "publishedAt"
          `,
            [
              expected.runId,
              expected.mapDateFrom,
              expected.dateThrough,
              expected.sourceRevision,
              expected.historicComputeEpoch,
              nextMapGeneration,
              String(publicationRows[0].revision),
              expected.artifacts.length,
              expected.dayCount,
              HISTORIC_BACKFILL_PUBLIC_MAP_MANIFEST_KEY,
              manifestBody,
              manifestChecksum,
            ],
          ),
        );
      if (outboxRows.length !== 1) {
        throw new Error('Historic map publication outbox preparation failed');
      }

      await queryRunner.commitTransaction();
      transactionStarted = false;
      return this.normalizePublication(outboxRows[0]);
    } catch (error) {
      primaryError = error;
      if (transactionStarted) {
        await queryRunner.rollbackTransaction();
        transactionStarted = false;
      }
      throw error;
    } finally {
      await this.cleanupLocks(
        queryRunner,
        zoneLockAcquired,
        statisticLockAcquired,
        primaryError,
      );
    }
  }

  private async publishPendingPublication(
    expected: HistoricBackfillMapPublication,
  ): Promise<HistoricBackfillMapFinalizationResult> {
    if (expected.status === 'published') {
      return this.toResult(expected, 'applied');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    let publicationLockAcquired = false;
    let primaryError: unknown = null;
    await queryRunner.connect();
    try {
      publicationLockAcquired =
        await this.tryAcquireManifestPublicationLock(queryRunner);
      if (!publicationLockAcquired) {
        throw new Error('Historic map manifest publication is already running');
      }

      const publication = await this.revalidatePendingPublicationBeforeUpload(
        queryRunner,
        expected,
      );
      if (publication.status === 'published') {
        return this.toResult(publication, 'applied');
      }

      await this.switchPublicManifest(publication.manifestBody);
      return await this.acknowledgePendingPublication(queryRunner, publication);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await this.cleanupManifestPublicationLock(
        queryRunner,
        publicationLockAcquired,
        primaryError,
      );
    }
  }

  private async revalidatePendingPublicationBeforeUpload(
    queryRunner: QueryRunner,
    expected: HistoricBackfillMapPublication,
  ): Promise<HistoricBackfillMapPublication> {
    let transactionStarted = false;
    try {
      await queryRunner.startTransaction('READ COMMITTED');
      transactionStarted = true;
      const lockedRow = await this.findPublication(
        queryRunner,
        expected.runId,
        true,
      );
      if (!lockedRow) {
        throw new Error('Historic map publication outbox row disappeared');
      }
      const actual = this.normalizePublication(lockedRow);
      this.assertSamePublication(expected, actual);
      if (actual.status === 'pending') {
        await this.assertPendingPublicationContext(queryRunner, actual.runId);
      }

      await queryRunner.commitTransaction();
      transactionStarted = false;
      return actual;
    } catch (error) {
      if (transactionStarted) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    }
  }

  private async assertPendingPublicationContext(
    queryable: Queryable,
    runId: string,
  ): Promise<void> {
    const [priority] = (await queryable.query(
      `
        SELECT
          (
            SELECT COUNT(*)::integer
            FROM "current_zone_recompute_request" request
            WHERE request."currentPending"
              OR EXISTS (
                SELECT 1
                FROM unnest(request."pendingScheduledDates")
                  AS pending_dates(pending_date)
                WHERE pending_date <=
                  (now() AT TIME ZONE 'Europe/Paris')::date
              )
          ) AS "currentQueueCount",
          (
            SELECT COUNT(*)::integer
            FROM "statistic_commune_snapshot" snapshot
            WHERE snapshot."status" = 'running'
          ) AS "runningSnapshotCount",
          (
            SELECT COUNT(*)::integer
            FROM "external_publication_run" daily_run
            WHERE daily_run."jobKey" = 'compute:national-daily'
              AND daily_run."status" = 'running'
          ) AS "runningDailyCount",
          (
            SELECT COUNT(*)::integer
            FROM "historic_backfill_run" run
            WHERE run."id" = $1::uuid
              AND run."statisticsPromotedAt" IS NOT NULL
          ) AS "statisticsPromotedCount"
      `,
      [runId],
    )) as CurrentPriorityRow[];
    if (!priority) {
      throw new Error('Current computation priority state is missing');
    }
    if (
      count(priority.currentQueueCount, 'current queue count') !== 0 ||
      count(priority.runningSnapshotCount, 'running snapshot count') !== 0 ||
      count(priority.runningDailyCount, 'running daily count') !== 0
    ) {
      throw new Error('Current computation has priority over historic maps');
    }
    if (
      count(
        priority.statisticsPromotedCount,
        'statistics promoted run count',
      ) !== 1
    ) {
      throw new Error(
        'Historic statistics have not been promoted for this run',
      );
    }
  }

  private async acknowledgePendingPublication(
    queryRunner: QueryRunner,
    expected: HistoricBackfillMapPublication,
  ): Promise<HistoricBackfillMapFinalizationResult> {
    let transactionStarted = false;
    try {
      await queryRunner.startTransaction('READ COMMITTED');
      transactionStarted = true;
      const lockedRow = await this.findPublication(
        queryRunner,
        expected.runId,
        true,
      );
      if (!lockedRow) {
        throw new Error('Historic map publication outbox row disappeared');
      }
      const actual = this.normalizePublication(lockedRow);
      this.assertSamePublication(expected, actual);
      if (actual.status === 'published') {
        await queryRunner.commitTransaction();
        transactionStarted = false;
        return this.toResult(actual, 'applied');
      }

      const publishedRows = unwrapTypeOrmDmlReturningRows<{ id: string }>(
        await queryRunner.query(
          `
            UPDATE "historic_backfill_map_manifest_outbox"
            SET
              "status" = 'published',
              "publishedAt" = now(),
              "lastError" = NULL,
              "updatedAt" = now()
            WHERE "runId" = $1::uuid
              AND "status" = 'pending'
              AND "manifestChecksum" = $2
            RETURNING "runId" AS "id"
          `,
          [actual.runId, actual.manifestChecksum],
        ),
      );
      if (publishedRows.length !== 1) {
        throw new Error(
          'Historic map publication outbox acknowledgement failed',
        );
      }

      const runRows = unwrapTypeOrmDmlReturningRows<{ id: string }>(
        await queryRunner.query(
          `
            UPDATE "historic_backfill_run"
            SET
              "status" = 'completed',
              "completedAt" = now(),
              "lastError" = NULL,
              "updatedAt" = now()
            WHERE "id" = $1::uuid
              AND "status" IN ('running', 'paused')
              AND "sourceRevision" = $2::bigint
              AND "historicComputeEpoch" = $3::bigint
            RETURNING "id"
          `,
          [actual.runId, actual.sourceRevision, actual.historicComputeEpoch],
        ),
      );
      if (runRows.length !== 1) {
        throw new Error('Historic backfill run completion failed');
      }

      await queryRunner.commitTransaction();
      transactionStarted = false;
      return this.toResult(
        { ...actual, status: 'published', publishedAt: new Date() },
        'applied',
      );
    } catch (error) {
      if (transactionStarted) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    }
  }

  private assertSamePublication(
    expected: HistoricBackfillMapPublication,
    actual: HistoricBackfillMapPublication,
  ): void {
    const identity = (publication: HistoricBackfillMapPublication) =>
      JSON.stringify({
        runId: publication.runId,
        mapDateFrom: publication.mapDateFrom,
        dateThrough: publication.dateThrough,
        sourceRevision: publication.sourceRevision,
        historicComputeEpoch: publication.historicComputeEpoch,
        mapGeneration: publication.mapGeneration,
        statisticRevision: publication.statisticRevision,
        artifactTaskCount: publication.artifactTaskCount,
        dayCount: publication.dayCount,
        manifestObjectKey: publication.manifestObjectKey,
        manifestChecksum: publication.manifestChecksum,
        manifestBody: publication.manifestBody,
      });
    if (identity(expected) !== identity(actual)) {
      throw new Error('Historic map publication outbox context changed');
    }
  }

  private toResult(
    publication: HistoricBackfillMapPublication,
    mode: 'dry-run' | 'applied',
  ): HistoricBackfillMapFinalizationResult {
    return {
      runId: publication.runId,
      mode,
      mapDateFrom: publication.mapDateFrom,
      dateThrough: publication.dateThrough,
      artifactTaskCount: publication.artifactTaskCount,
      dayCount: publication.dayCount,
      copiedObjectCount: 0,
      verifiedObjectCount:
        mode === 'applied' ? publication.artifactTaskCount * 2 : 0,
      manifestObjectKey: publication.manifestObjectKey,
      mapGeneration: publication.mapGeneration,
      statisticRevision: publication.statisticRevision,
    };
  }

  private assertSamePlan(
    expected: HistoricBackfillMapPlan,
    actual: HistoricBackfillMapPlan,
  ): void {
    const identity = (plan: HistoricBackfillMapPlan) =>
      JSON.stringify({
        runId: plan.runId,
        mapDateFrom: plan.mapDateFrom,
        dateThrough: plan.dateThrough,
        sourceRevision: plan.sourceRevision,
        historicComputeEpoch: plan.historicComputeEpoch,
        historicBackfillGlobalEpoch: plan.historicBackfillGlobalEpoch,
        computeMapGeneration: plan.computeMapGeneration,
        artifacts: plan.artifacts,
      });
    if (identity(expected) !== identity(actual)) {
      throw new Error(
        'Historic map finalization context changed during validation',
      );
    }
  }

  private async tryAcquireManifestPublicationLock(
    queryRunner: QueryRunner,
  ): Promise<boolean> {
    const [result] = await queryRunner.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [HISTORIC_BACKFILL_MAP_MANIFEST_PUBLICATION_LOCK],
    );
    return result?.locked === true;
  }

  private async cleanupManifestPublicationLock(
    queryRunner: QueryRunner,
    lockAcquired: boolean,
    primaryError: unknown,
  ): Promise<void> {
    const cleanupErrors: unknown[] = [];
    if (lockAcquired) {
      try {
        const [result] = await queryRunner.query(
          'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
          [HISTORIC_BACKFILL_MAP_MANIFEST_PUBLICATION_LOCK],
        );
        if (result?.unlocked !== true) {
          throw new Error(
            'Historic map manifest publication lock was not released',
          );
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await queryRunner.release();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0 && primaryError === null) {
      throw new AggregateError(
        cleanupErrors,
        'Historic map manifest publication cleanup failed',
      );
    }
  }

  private async tryAcquireZoneLock(queryRunner: QueryRunner): Promise<boolean> {
    const [result] = await queryRunner.query(
      "SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('zone-compute-global')) AS locked",
    );
    return result?.locked === true;
  }

  private async tryAcquireStatisticLock(
    queryRunner: QueryRunner,
  ): Promise<boolean> {
    const [result] = await queryRunner.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [STATISTIC_COMMUNE_LOCK],
    );
    return result?.locked === true;
  }

  private async cleanupLocks(
    queryRunner: QueryRunner,
    zoneLockAcquired: boolean,
    statisticLockAcquired: boolean,
    primaryError: unknown,
  ): Promise<void> {
    const cleanupErrors: unknown[] = [];
    if (statisticLockAcquired) {
      try {
        const [result] = await queryRunner.query(
          'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
          [STATISTIC_COMMUNE_LOCK],
        );
        if (result?.unlocked !== true) {
          throw new Error('Statistic commune lock was not released');
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (zoneLockAcquired) {
      try {
        const [result] = await queryRunner.query(
          "SELECT pg_advisory_unlock(hashtext('vigieau'), hashtext('zone-compute-global')) AS unlocked",
        );
        if (result?.unlocked !== true) {
          throw new Error('Zone compute lock was not released');
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await queryRunner.release();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0 && primaryError === null) {
      throw new AggregateError(
        cleanupErrors,
        'Historic map finalizer cleanup failed',
      );
    }
  }
}
