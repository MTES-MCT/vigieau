import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Departement } from '@shared/entities/departement.entity';
import { ZoneAlerteComputed } from '@shared/entities/zone_alerte_computed.entity';
import { ZoneAlerteComputedHistoric } from '@shared/entities/zone_alerte_computed_historic.entity';
// Moment exposes a CommonJS callable export under the current Jest/NodeNext setup.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import moment = require('moment');
import { DataSource, QueryRunner } from 'typeorm';
import { DepartementService } from '../departement/departement.service';
import {
  HistoricCommuneStatisticSegmentBatch,
  HistoricCommuneStatisticSegmentSink,
  StatisticCommuneService,
} from '../statistic_commune/statistic_commune.service';
import { ZoneAlerteComputedHistoricService } from '../zone_alerte_computed/zone_alerte_computed_historic.service';
import { HISTORIC_BACKFILL_DURING_CURRENT_CONCURRENCY_MAX } from './historic-backfill.config';
import {
  HistoricBackfillTaskClaim,
  HistoricBackfillTaskContext,
  HistoricBackfillTaskHandler,
  HistoricBackfillTaskInterruptedError,
  HistoricBackfillTaskOutput,
} from './historic-backfill.types';

export const HISTORIC_BACKFILL_LEGACY_ZONE_PROVIDER =
  'HISTORIC_BACKFILL_LEGACY_ZONE_PROVIDER';
export const HISTORIC_BACKFILL_DEPARTMENT_PAYLOAD_BUILDER =
  'HISTORIC_BACKFILL_DEPARTMENT_PAYLOAD_BUILDER';
export const HISTORIC_BACKFILL_MAP_ARTIFACT_BUILDER =
  'HISTORIC_BACKFILL_MAP_ARTIFACT_BUILDER';
export const HISTORIC_BACKFILL_CURRENT_PRIORITY =
  'HISTORIC_BACKFILL_CURRENT_PRIORITY';

export const COMPUTED_HISTORIC_START_DATE = '2024-04-29';

const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface HistoricBackfillStableSegment {
  validFrom: string;
  validThrough: string;
}

export interface HistoricBackfillLegacyZoneProvider {
  computeAndFindZones(
    departement: Departement,
    computedFor: string,
    context: {
      signal: AbortSignal;
      historicComputeEpoch: string;
      departmentGeneration: string;
    },
  ): Promise<ZoneAlerteComputedHistoric[]>;
}

export interface HistoricBackfillDepartmentPayload {
  restriction: Record<string, unknown>;
  situation: Record<string, unknown>;
}

export interface HistoricBackfillDepartmentPayloadBuilder {
  build(
    zones: readonly ZoneAlerteComputedHistoric[],
    computedFor: string,
    legacy: boolean,
    context: {
      departementId: number;
      departementCode: string;
    },
  ):
    | HistoricBackfillDepartmentPayload
    | Promise<HistoricBackfillDepartmentPayload>;
}

export interface HistoricBackfillMapArtifact {
  objectKey: string;
  checksum: string;
  featureCount: number;
}

export interface HistoricBackfillMapArtifactBuilder {
  buildAndUpload(
    zones: readonly ZoneAlerteComputedHistoric[],
    claim: HistoricBackfillTaskClaim,
    validFrom: string,
    validThrough: string,
    legacy: boolean,
    context: { signal: AbortSignal },
  ): HistoricBackfillMapArtifact | Promise<HistoricBackfillMapArtifact>;
}

export interface HistoricBackfillCurrentPriority {
  shouldYield(claim: HistoricBackfillTaskClaim): Promise<boolean>;
}

export type HistoricBackfillDepartmentLockResult<T> =
  | { acquired: false }
  | { acquired: true; value: T };

interface HistoricBackfillInputSignatureContext {
  departementId: number;
  departementCode: string;
  departmentGeneration: string;
  departmentLastPublicRevision: string;
  historicComputeEpoch: string;
  baseStatisticRevision: string;
  validFrom: string;
  validThrough: string;
  legacy: boolean;
}

interface HistoricBackfillPersistedOutput {
  outputSignature: string;
  segmentCount: number;
  communeCount: number;
}

function assertCivilDate(name: string, value: string): void {
  if (!CIVIL_DATE_PATTERN.test(value)) {
    throw new Error(`${name} must use the YYYY-MM-DD format`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${name} is not a valid civil date`);
  }
}

function shiftCivilDate(value: string, days: number): string {
  assertCivilDate('date', value);
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function databaseBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 't';
}

function databaseCount(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${String(value)}`);
  }
  return parsed;
}

export async function withHistoricBackfillDepartmentLock<T>(
  dataSource: DataSource,
  departementId: number,
  task: () => Promise<T>,
): Promise<HistoricBackfillDepartmentLockResult<T>> {
  const queryRunner: QueryRunner = dataSource.createQueryRunner();
  let connected = false;
  let historicSharedAcquired = false;
  let departmentAcquired = false;
  try {
    await queryRunner.connect();
    connected = true;
    const [historicLockResult] = await queryRunner.query(
      `
        SELECT pg_try_advisory_lock_shared(
          hashtext('vigieau'), hashtext('zone-compute-historic')
        ) AS "locked"
      `,
    );
    historicSharedAcquired = databaseBoolean(historicLockResult?.locked);
    if (!historicSharedAcquired) {
      return { acquired: false };
    }
    const [lockResult] = await queryRunner.query(
      `
        SELECT pg_try_advisory_lock(
          hashtext('vigieau:historic-backfill-department'),
          $1::integer
        ) AS "locked"
      `,
      [departementId],
    );
    departmentAcquired = databaseBoolean(lockResult?.locked);
    if (!departmentAcquired) {
      return { acquired: false };
    }
    return { acquired: true, value: await task() };
  } finally {
    let cleanupError: unknown;
    if (departmentAcquired) {
      try {
        const [unlockResult] = await queryRunner.query(
          `
            SELECT pg_advisory_unlock(
              hashtext('vigieau:historic-backfill-department'),
              $1::integer
            ) AS "unlocked"
          `,
          [departementId],
        );
        if (!databaseBoolean(unlockResult?.unlocked)) {
          cleanupError = new Error(
            `Unable to release historic department lock ${departementId}`,
          );
        }
      } catch (error) {
        cleanupError = error;
      }
    }
    if (historicSharedAcquired) {
      try {
        const [unlockResult] = await queryRunner.query(
          `
            SELECT pg_advisory_unlock_shared(
              hashtext('vigieau'), hashtext('zone-compute-historic')
            ) AS "unlocked"
          `,
        );
        if (!databaseBoolean(unlockResult?.unlocked)) {
          cleanupError ??= new Error(
            'Unable to release shared historic compute lock',
          );
        }
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (connected) {
      try {
        await queryRunner.release();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError) {
      throw cleanupError;
    }
  }
}

export function buildHistoricBackfillStableSegments(
  mapDateFrom: string,
  dateThrough: string,
  sourceBoundaries: readonly string[],
): HistoricBackfillStableSegment[] {
  assertCivilDate('mapDateFrom', mapDateFrom);
  assertCivilDate('dateThrough', dateThrough);
  if (mapDateFrom > dateThrough) {
    throw new Error('mapDateFrom must not be after dateThrough');
  }

  const boundaries = [...new Set([mapDateFrom, ...sourceBoundaries])]
    .map((boundary) => {
      assertCivilDate('source boundary', boundary);
      return boundary;
    })
    .filter((boundary) => boundary >= mapDateFrom && boundary <= dateThrough)
    .sort();

  return boundaries.map((validFrom, index) => ({
    validFrom,
    validThrough:
      index + 1 < boundaries.length
        ? shiftCivilDate(boundaries[index + 1], -1)
        : dateThrough,
  }));
}

export function createHistoricBackfillInputSignature(
  context: HistoricBackfillInputSignatureContext,
): string {
  return sha256({
    materializationVersion: 1,
    departementId: context.departementId,
    departementCode: context.departementCode,
    departmentGeneration: context.departmentGeneration,
    departmentLastPublicRevision: context.departmentLastPublicRevision,
    historicComputeEpoch: context.historicComputeEpoch,
    baseStatisticRevision: context.baseStatisticRevision,
    validFrom: context.validFrom,
    validThrough: context.validThrough,
    legacy: context.legacy,
  });
}

@Injectable()
export class SqlHistoricBackfillCurrentPriority implements HistoricBackfillCurrentPriority {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async shouldYield(claim: HistoricBackfillTaskClaim): Promise<boolean> {
    const [row] = await this.dataSource.query(
      `
        WITH priority AS MATERIALIZED (
          SELECT
            EXISTS (
              SELECT 1
              FROM "current_zone_recompute_request" request
              WHERE request."nextAttemptAt" <= now()
                AND (
                  request."currentPending"
                  OR EXISTS (
                    SELECT 1
                    FROM unnest(request."pendingScheduledDates")
                      AS pending_dates(pending_date)
                    WHERE pending_date <=
                      (now() AT TIME ZONE 'Europe/Paris')::date
                  )
                )
            ) AS "currentQueueDue",
            (
              EXISTS (
                SELECT 1
                FROM "external_publication_run" daily_run
                WHERE daily_run."jobKey" = 'compute:national-daily'
                  AND daily_run."status" = 'running'
              )
              OR EXISTS (
                SELECT 1
                FROM "statistic_commune_snapshot" snapshot
                WHERE snapshot."status" = 'running'
              )
            ) AS "hardBlockActive"
        ), protected_leases AS MATERIALIZED (
          SELECT
            task."runId", task."departementId",
            task."leaseOwner", task."leaseToken"
          FROM "historic_backfill_task" task
          JOIN "historic_backfill_run" run ON run."id" = task."runId"
          JOIN "historic_backfill_department_revision" revision
            ON revision."departementId" = task."departementId"
          CROSS JOIN "config" config
          WHERE task."status" = 'leased'
            AND task."leaseExpiresAt" > now()
            AND (SELECT priority."currentQueueDue" FROM priority)
            AND run."status" = 'running'
            AND config."id" = 1
            AND run."historicComputeEpoch" = config."historicComputeEpoch"
            AND run."historicBackfillGlobalEpoch" =
              config."historicBackfillGlobalEpoch"
            AND task."departmentGeneration" = revision."generation"
          ORDER BY
            task."startedAt" ASC NULLS LAST,
            task."runId",
            task."departementId"
          LIMIT ($5::integer)
        )
        SELECT (
          priority."hardBlockActive"
          OR (
            priority."currentQueueDue"
            AND NOT EXISTS (
              SELECT 1
              FROM protected_leases protected
              WHERE protected."runId" = $1::uuid
                AND protected."departementId" = $2::integer
                AND protected."leaseOwner" = $3
                AND protected."leaseToken" = $4::uuid
            )
          )
        ) AS "shouldYield"
        FROM priority
      `,
      [
        claim.runId,
        claim.departementId,
        claim.workerId,
        claim.leaseToken,
        claim.duringCurrentConcurrency,
      ],
    );
    return databaseBoolean(row?.shouldYield);
  }
}

export class SqlHistoricBackfillCommuneSegmentSink implements HistoricCommuneStatisticSegmentSink {
  constructor(
    private readonly dataSource: DataSource,
    private readonly claim: HistoricBackfillTaskClaim,
    private readonly expected: {
      computedFor: string;
      validThrough: string;
      inputSignature: string;
    },
    private readonly beforeWrite: () => Promise<void>,
    private readonly onLostContext: () => Promise<never>,
  ) {}

  async writeSegments(
    batch: HistoricCommuneStatisticSegmentBatch,
  ): Promise<void> {
    await this.beforeWrite();
    this.validateBatch(batch);
    if (batch.segments.length === 0) {
      return;
    }

    const [result] = await this.dataSource.query(
      `
        WITH current_context AS MATERIALIZED (
          SELECT 1
          FROM "historic_backfill_task" task
          JOIN "historic_backfill_department_revision" revision
            ON revision."departementId" = task."departementId"
          JOIN "historic_backfill_run" run ON run."id" = task."runId"
          CROSS JOIN "config" config
          WHERE task."runId" = $1::uuid
            AND task."departementId" = $2::integer
            AND task."status" = 'leased'
            AND task."leaseOwner" = $3
            AND task."leaseToken" = $4::uuid
            AND task."leaseExpiresAt" > now()
            AND task."departmentGeneration" = $5::bigint
            AND revision."generation" = $5::bigint
            AND run."status" = 'running'
            AND run."historicComputeEpoch" = $8::bigint
            AND config."id" = 1
            AND config."historicComputeEpoch" = run."historicComputeEpoch"
            AND run."historicBackfillGlobalEpoch" =
              config."historicBackfillGlobalEpoch"
          FOR UPDATE OF task, revision
        ), incoming AS MATERIALIZED (
          SELECT *
          FROM jsonb_to_recordset($6::jsonb) AS input(
            "communeId" integer,
            "validFrom" date,
            "validThrough" date,
            "SOU" varchar(20),
            "SUP" varchar(20),
            "AEP" varchar(20)
          )
        ), upserted AS (
          INSERT INTO "historic_backfill_commune_segment" AS target (
            "runId", "departementId", "communeId", "validFrom",
            "validThrough", "SOU", "SUP", "AEP", "sourceGeneration",
            "inputSignature"
          )
          SELECT
            $1::uuid, $2::integer, incoming."communeId",
            incoming."validFrom", incoming."validThrough", incoming."SOU",
            incoming."SUP", incoming."AEP", $5::bigint, $7
          FROM incoming
          WHERE EXISTS (SELECT 1 FROM current_context)
          ON CONFLICT ("runId", "communeId", "validFrom") DO UPDATE
          SET
            "validThrough" = EXCLUDED."validThrough",
            "SOU" = EXCLUDED."SOU",
            "SUP" = EXCLUDED."SUP",
            "AEP" = EXCLUDED."AEP",
            "sourceGeneration" = EXCLUDED."sourceGeneration",
            "inputSignature" = EXCLUDED."inputSignature"
          WHERE target."departementId" = EXCLUDED."departementId"
            AND target."validThrough" = EXCLUDED."validThrough"
            AND target."SOU" IS NOT DISTINCT FROM EXCLUDED."SOU"
            AND target."SUP" IS NOT DISTINCT FROM EXCLUDED."SUP"
            AND target."AEP" IS NOT DISTINCT FROM EXCLUDED."AEP"
            AND target."sourceGeneration" = EXCLUDED."sourceGeneration"
            AND target."inputSignature" = EXCLUDED."inputSignature"
          RETURNING 1
        )
        SELECT
          EXISTS (SELECT 1 FROM current_context) AS "contextMatches",
          (SELECT COUNT(*)::integer FROM incoming) AS "inputCount",
          (SELECT COUNT(*)::integer FROM upserted) AS "upsertedCount"
      `,
      [
        this.claim.runId,
        this.claim.departementId,
        this.claim.workerId,
        this.claim.leaseToken,
        this.claim.departmentGeneration,
        JSON.stringify(
          batch.segments.map((segment) => ({
            communeId: segment.communeId,
            validFrom: segment.validFrom,
            validThrough: segment.validThrough,
            SOU: segment.SOU,
            SUP: segment.SUP,
            AEP: segment.AEP,
          })),
        ),
        this.expected.inputSignature,
        this.claim.historicComputeEpoch,
      ],
    );

    if (!databaseBoolean(result?.contextMatches)) {
      await this.onLostContext();
    }
    const inputCount = databaseCount(result?.inputCount, 'segment input count');
    const upsertedCount = databaseCount(
      result?.upsertedCount,
      'segment upsert count',
    );
    if (
      inputCount !== batch.segments.length ||
      upsertedCount !== batch.segments.length
    ) {
      throw new Error(
        `Historic commune segment conflict for ${this.claim.departementCode} on ${this.expected.computedFor}`,
      );
    }
  }

  private validateBatch(batch: HistoricCommuneStatisticSegmentBatch): void {
    if (
      batch.runId !== this.claim.runId ||
      batch.departementId !== this.claim.departementId ||
      batch.departementCode !== this.claim.departementCode ||
      batch.sourceGeneration !== this.claim.departmentGeneration ||
      batch.computedFor !== this.expected.computedFor ||
      batch.validThrough !== this.expected.validThrough ||
      batch.inputSignature !== this.expected.inputSignature
    ) {
      throw new Error('Historic commune segment batch context mismatch');
    }
    for (const segment of batch.segments) {
      if (
        segment.runId !== batch.runId ||
        segment.departementId !== batch.departementId ||
        segment.sourceGeneration !== batch.sourceGeneration ||
        segment.inputSignature !== batch.inputSignature ||
        segment.validFrom !== batch.computedFor ||
        segment.validThrough !== batch.validThrough
      ) {
        throw new Error('Historic commune segment row context mismatch');
      }
    }
  }
}

@Injectable()
export class HistoricBackfillTaskHandlerService {
  private readonly currentPriority: HistoricBackfillCurrentPriority;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly departementService: DepartementService,
    private readonly historicZoneService: ZoneAlerteComputedHistoricService,
    private readonly statisticCommuneService: StatisticCommuneService,
    @Optional()
    @Inject(HISTORIC_BACKFILL_LEGACY_ZONE_PROVIDER)
    private readonly legacyZoneProvider?: HistoricBackfillLegacyZoneProvider,
    @Inject(HISTORIC_BACKFILL_DEPARTMENT_PAYLOAD_BUILDER)
    private readonly departmentPayloadBuilder?: HistoricBackfillDepartmentPayloadBuilder,
    @Inject(HISTORIC_BACKFILL_MAP_ARTIFACT_BUILDER)
    private readonly mapArtifactBuilder?: HistoricBackfillMapArtifactBuilder,
    @Optional()
    @Inject(HISTORIC_BACKFILL_CURRENT_PRIORITY)
    currentPriority?: HistoricBackfillCurrentPriority,
  ) {
    this.currentPriority =
      currentPriority ?? new SqlHistoricBackfillCurrentPriority(dataSource);
  }

  readonly handle: HistoricBackfillTaskHandler = async (claim, context) =>
    this.handleTask(claim, context);

  private async handleTask(
    claim: HistoricBackfillTaskClaim,
    context: HistoricBackfillTaskContext,
  ): Promise<HistoricBackfillTaskOutput> {
    this.validateClaim(claim);
    await this.assertCanContinue(claim, context.signal);
    const departement = await this.loadDepartement(claim);
    const segments = await this.loadStableSegments(claim);
    let segmentCount = claim.segmentCount;
    let communeCount = claim.communeCount;
    let artifactPrefix = claim.artifactPrefix;
    let previousComputedFor: string | null = null;

    for (const segment of segments) {
      if (claim.progressDate && segment.validThrough <= claim.progressDate) {
        previousComputedFor = segment.validFrom;
        continue;
      }

      await this.assertCanContinue(claim, context.signal);
      const legacy = segment.validFrom < COMPUTED_HISTORIC_START_DATE;
      const zones = await this.computeAndFindZones(
        claim,
        context.signal,
        departement,
        segment.validFrom,
        previousComputedFor,
        legacy,
      );
      await this.assertCanContinue(claim, context.signal);

      const inputSignature = createHistoricBackfillInputSignature({
        departementId: claim.departementId,
        departementCode: claim.departementCode,
        departmentGeneration: claim.departmentGeneration,
        departmentLastPublicRevision: claim.departmentLastPublicRevision,
        historicComputeEpoch: claim.historicComputeEpoch,
        baseStatisticRevision: claim.baseStatisticRevision,
        validFrom: segment.validFrom,
        validThrough: segment.validThrough,
        legacy,
      });
      const payload = await this.buildDepartmentPayload(
        zones,
        claim,
        segment.validFrom,
        legacy,
      );
      const mapArtifact = await this.buildMapArtifact(
        zones,
        claim,
        segment,
        legacy,
        context.signal,
      );
      const segmentArtifactPrefix = this.getArtifactPrefix(
        mapArtifact.objectKey,
      );
      if (artifactPrefix && artifactPrefix !== segmentArtifactPrefix) {
        throw new Error(
          `Historic map artifact prefix mismatch for ${claim.departementCode}`,
        );
      }
      artifactPrefix ??= segmentArtifactPrefix;
      await this.assertCanContinue(claim, context.signal);
      await this.upsertDepartmentSegment(
        claim,
        segment,
        inputSignature,
        payload,
        mapArtifact,
      );

      if (segment.validThrough >= claim.statisticDateFrom) {
        const statisticValidFrom =
          segment.validFrom < claim.statisticDateFrom
            ? claim.statisticDateFrom
            : segment.validFrom;
        const sink = new SqlHistoricBackfillCommuneSegmentSink(
          this.dataSource,
          claim,
          {
            computedFor: statisticValidFrom,
            validThrough: segment.validThrough,
            inputSignature,
          },
          () => this.assertCanContinue(claim, context.signal),
          () => this.throwLostContext(claim),
        );
        const staged =
          await this.statisticCommuneService.stageHistoricCommuneStatisticsRestrictions(
            zones as unknown as ZoneAlerteComputed[],
            new Date(`${statisticValidFrom}T00:00:00.000Z`),
            {
              runId: claim.runId,
              departementId: claim.departementId,
              departementCode: claim.departementCode,
              sourceGeneration: claim.departmentGeneration,
              inputSignature,
              validThrough: segment.validThrough,
              historicNotComputed: legacy,
              sink,
            },
          );
        if (
          staged.processedCommuneCount !== staged.expectedCommuneCount ||
          staged.segmentCount < staged.processedCommuneCount
        ) {
          throw new Error(
            `Incomplete historic commune staging for ${claim.departementCode} on ${statisticValidFrom}`,
          );
        }
        segmentCount += staged.segmentCount;
        communeCount = staged.expectedCommuneCount;
      }

      await this.assertCanContinue(claim, context.signal);
      const heartbeatAccepted = await context.heartbeat({
        progressDate: segment.validThrough,
        segmentCount,
        communeCount,
        artifactPrefix,
      });
      if (!heartbeatAccepted) {
        await this.throwLostContext(claim);
      }
      previousComputedFor = segment.validFrom;
    }

    await this.assertCanContinue(claim, context.signal);
    const persisted = await this.readPersistedOutput(claim);
    return {
      progressDate: claim.dateThrough,
      segmentCount: persisted.segmentCount,
      communeCount: persisted.communeCount,
      outputSignature: persisted.outputSignature,
      artifactPrefix,
    };
  }

  private validateClaim(claim: HistoricBackfillTaskClaim): void {
    assertCivilDate('mapDateFrom', claim.mapDateFrom);
    assertCivilDate('statisticDateFrom', claim.statisticDateFrom);
    assertCivilDate('dateThrough', claim.dateThrough);
    if (
      claim.mapDateFrom > claim.dateThrough ||
      claim.statisticDateFrom > claim.dateThrough
    ) {
      throw new Error('Invalid historic backfill task date range');
    }
    if (
      !Number.isSafeInteger(claim.departementId) ||
      claim.departementId <= 0 ||
      !/^\d+$/.test(claim.departmentGeneration) ||
      !Number.isSafeInteger(claim.duringCurrentConcurrency) ||
      claim.duringCurrentConcurrency < 0 ||
      claim.duringCurrentConcurrency >
        HISTORIC_BACKFILL_DURING_CURRENT_CONCURRENCY_MAX
    ) {
      throw new Error('Invalid historic backfill task department context');
    }
  }

  private async loadDepartement(
    claim: HistoricBackfillTaskClaim,
  ): Promise<Departement> {
    const departement = (await this.departementService.findAllLight()).find(
      (candidate) => candidate.id === claim.departementId,
    );
    if (!departement || departement.code !== claim.departementCode) {
      throw new Error(
        `Historic backfill department not found: ${claim.departementId}/${claim.departementCode}`,
      );
    }
    departement.parametres ??= [];
    return departement;
  }

  private async loadStableSegments(
    claim: HistoricBackfillTaskClaim,
  ): Promise<HistoricBackfillStableSegment[]> {
    const rows = (await this.dataSource.query(
      `
        WITH source_boundaries AS (
          SELECT $2::date AS "boundaryDate"
          UNION
          SELECT ar."dateDebut"
          FROM "arrete_restriction" ar
          WHERE ar."departementId" = $1::integer
            AND ar."statut" IN ('publie', 'abroge')
            AND ar."dateDebut" IS NOT NULL
          UNION
          SELECT ar."dateFin" + 1
          FROM "arrete_restriction" ar
          WHERE ar."departementId" = $1::integer
            AND ar."statut" IN ('publie', 'abroge')
            AND ar."dateFin" IS NOT NULL
          UNION
          SELECT parametres."dateDebut"
          FROM "parametres"
          WHERE parametres."departementId" = $1::integer
          UNION
          SELECT parametres."dateFin" + 1
          FROM "parametres"
          WHERE parametres."departementId" = $1::integer
            AND parametres."dateFin" IS NOT NULL
        )
        SELECT "boundaryDate"::text AS "boundaryDate"
        FROM source_boundaries
        WHERE "boundaryDate" BETWEEN $2::date AND $3::date
        ORDER BY "boundaryDate"
      `,
      [claim.departementId, claim.mapDateFrom, claim.dateThrough],
    )) as Array<{ boundaryDate: string }>;
    return buildHistoricBackfillStableSegments(
      claim.mapDateFrom,
      claim.dateThrough,
      [COMPUTED_HISTORIC_START_DATE, ...rows.map((row) => row.boundaryDate)],
    );
  }

  private async computeAndFindZones(
    claim: HistoricBackfillTaskClaim,
    signal: AbortSignal,
    departement: Departement,
    computedFor: string,
    previousComputedFor: string | null,
    legacy: boolean,
  ): Promise<ZoneAlerteComputedHistoric[]> {
    const result = await withHistoricBackfillDepartmentLock(
      this.dataSource,
      claim.departementId,
      async () => {
        await this.assertCanContinue(claim, signal);
        if (legacy) {
          if (!this.legacyZoneProvider) {
            throw new Error(
              `Historic backfill before ${COMPUTED_HISTORIC_START_DATE} requires an injected legacy zone provider`,
            );
          }
          return this.legacyZoneProvider.computeAndFindZones(
            departement,
            computedFor,
            {
              signal,
              historicComputeEpoch: claim.historicComputeEpoch,
              departmentGeneration: claim.departmentGeneration,
            },
          );
        }

        await this.historicZoneService.computeZonesForDate(
          moment.utc(computedFor, 'YYYY-MM-DD', true),
          [departement],
          {
            previousDate: previousComputedFor,
            historicComputeEpoch: claim.historicComputeEpoch,
            expectedSourceRevision: undefined,
          },
        );
        this.throwIfAborted(signal);
        return this.historicZoneService.findZonesForHistoricBackfill([
          claim.departementCode,
        ]);
      },
    );
    if (!result.acquired) {
      throw new HistoricBackfillTaskInterruptedError(
        'current-priority',
        'Historic spatial compute yielded to current work',
      );
    }
    return result.value;
  }

  private async buildDepartmentPayload(
    zones: readonly ZoneAlerteComputedHistoric[],
    claim: HistoricBackfillTaskClaim,
    computedFor: string,
    legacy: boolean,
  ): Promise<HistoricBackfillDepartmentPayload> {
    if (!this.departmentPayloadBuilder) {
      throw new Error(
        'Historic backfill department payload builder is missing',
      );
    }
    const payload = await this.departmentPayloadBuilder.build(
      zones,
      computedFor,
      legacy,
      {
        departementId: claim.departementId,
        departementCode: claim.departementCode,
      },
    );
    if (
      !isPlainObject(payload?.restriction) ||
      !isPlainObject(payload?.situation)
    ) {
      throw new Error(
        'Historic backfill department payload must contain objects',
      );
    }
    return payload;
  }

  private async buildMapArtifact(
    zones: readonly ZoneAlerteComputedHistoric[],
    claim: HistoricBackfillTaskClaim,
    segment: HistoricBackfillStableSegment,
    legacy: boolean,
    signal: AbortSignal,
  ): Promise<HistoricBackfillMapArtifact> {
    if (!this.mapArtifactBuilder) {
      throw new Error('Historic backfill map artifact builder is missing');
    }
    const artifact = await this.mapArtifactBuilder.buildAndUpload(
      zones,
      claim,
      segment.validFrom,
      segment.validThrough,
      legacy,
      { signal },
    );
    if (
      typeof artifact?.objectKey !== 'string' ||
      artifact.objectKey.trim() !== artifact.objectKey ||
      artifact.objectKey.length === 0 ||
      !SHA256_PATTERN.test(artifact.checksum) ||
      !Number.isSafeInteger(artifact.featureCount) ||
      artifact.featureCount < 0
    ) {
      throw new Error('Historic backfill map artifact identity is invalid');
    }
    return artifact;
  }

  private getArtifactPrefix(objectKey: string): string {
    const separator = objectKey.lastIndexOf('/');
    return separator > 0 ? objectKey.slice(0, separator) : objectKey;
  }

  private async upsertDepartmentSegment(
    claim: HistoricBackfillTaskClaim,
    segment: HistoricBackfillStableSegment,
    inputSignature: string,
    payload: HistoricBackfillDepartmentPayload,
    mapArtifact: HistoricBackfillMapArtifact,
  ): Promise<void> {
    const [result] = await this.dataSource.query(
      `
        WITH current_context AS MATERIALIZED (
          SELECT 1
          FROM "historic_backfill_task" task
          JOIN "historic_backfill_department_revision" revision
            ON revision."departementId" = task."departementId"
          JOIN "historic_backfill_run" run ON run."id" = task."runId"
          CROSS JOIN "config" config
          WHERE task."runId" = $1::uuid
            AND task."departementId" = $2::integer
            AND task."status" = 'leased'
            AND task."leaseOwner" = $12
            AND task."leaseToken" = $13::uuid
            AND task."leaseExpiresAt" > now()
            AND task."departmentGeneration" = $5::bigint
            AND revision."generation" = $5::bigint
            AND run."status" = 'running'
            AND run."historicComputeEpoch" = $14::bigint
            AND config."id" = 1
            AND config."historicComputeEpoch" = run."historicComputeEpoch"
            AND run."historicBackfillGlobalEpoch" =
              config."historicBackfillGlobalEpoch"
          FOR UPDATE OF task, revision
        ), upserted AS (
          INSERT INTO "historic_backfill_department_segment" AS target (
            "runId", "departementId", "validFrom", "validThrough",
            "sourceGeneration", "inputSignature", "restriction", "situation",
            "geojsonObjectKey", "geojsonChecksum", "featureCount"
          )
          SELECT
            $1::uuid, $2::integer, $3::date, $4::date, $5::bigint, $6,
            $7::jsonb, $8::jsonb, $9, $10, $11::integer
          WHERE EXISTS (SELECT 1 FROM current_context)
          ON CONFLICT ("runId", "departementId", "validFrom") DO UPDATE
          SET
            "validThrough" = EXCLUDED."validThrough",
            "sourceGeneration" = EXCLUDED."sourceGeneration",
            "inputSignature" = EXCLUDED."inputSignature",
            "restriction" = EXCLUDED."restriction",
            "situation" = EXCLUDED."situation",
            "geojsonObjectKey" = EXCLUDED."geojsonObjectKey",
            "geojsonChecksum" = EXCLUDED."geojsonChecksum",
            "featureCount" = EXCLUDED."featureCount"
          WHERE target."validThrough" = EXCLUDED."validThrough"
            AND target."sourceGeneration" = EXCLUDED."sourceGeneration"
            AND target."inputSignature" = EXCLUDED."inputSignature"
            AND target."restriction" = EXCLUDED."restriction"
            AND target."situation" = EXCLUDED."situation"
            AND target."geojsonObjectKey" = EXCLUDED."geojsonObjectKey"
            AND target."geojsonChecksum" = EXCLUDED."geojsonChecksum"
            AND target."featureCount" = EXCLUDED."featureCount"
          RETURNING 1
        )
        SELECT
          EXISTS (SELECT 1 FROM current_context) AS "contextMatches",
          EXISTS (SELECT 1 FROM upserted) AS "upserted"
      `,
      [
        claim.runId,
        claim.departementId,
        segment.validFrom,
        segment.validThrough,
        claim.departmentGeneration,
        inputSignature,
        JSON.stringify(payload.restriction),
        JSON.stringify(payload.situation),
        mapArtifact.objectKey,
        mapArtifact.checksum,
        mapArtifact.featureCount,
        claim.workerId,
        claim.leaseToken,
        claim.historicComputeEpoch,
      ],
    );
    if (!databaseBoolean(result?.contextMatches)) {
      await this.throwLostContext(claim);
    }
    if (!databaseBoolean(result?.upserted)) {
      throw new Error(
        `Historic department segment conflict for ${claim.departementCode} on ${segment.validFrom}`,
      );
    }
  }

  private async readPersistedOutput(
    claim: HistoricBackfillTaskClaim,
  ): Promise<HistoricBackfillPersistedOutput> {
    const [departmentRows, communeRows] = await Promise.all([
      this.dataSource.query(
        `
          SELECT
            "validFrom"::text AS "validFrom",
            "validThrough"::text AS "validThrough",
            "inputSignature", "restriction", "situation",
            "geojsonObjectKey", "geojsonChecksum", "featureCount"
          FROM "historic_backfill_department_segment"
          WHERE "runId" = $1::uuid
            AND "departementId" = $2::integer
            AND "sourceGeneration" = $3::bigint
          ORDER BY "validFrom"
        `,
        [claim.runId, claim.departementId, claim.departmentGeneration],
      ),
      this.dataSource.query(
        `
          SELECT
            "communeId", "validFrom"::text AS "validFrom",
            "validThrough"::text AS "validThrough", "SOU", "SUP", "AEP",
            "inputSignature"
          FROM "historic_backfill_commune_segment"
          WHERE "runId" = $1::uuid
            AND "departementId" = $2::integer
            AND "sourceGeneration" = $3::bigint
          ORDER BY "communeId", "validFrom"
        `,
        [claim.runId, claim.departementId, claim.departmentGeneration],
      ),
    ]);
    const communeIds = new Set(
      (communeRows as Array<{ communeId: number | string }>).map((row) =>
        Number(row.communeId),
      ),
    );
    return {
      segmentCount: communeRows.length,
      communeCount: communeIds.size,
      outputSignature: sha256({
        materializationVersion: 1,
        departementId: claim.departementId,
        departmentGeneration: claim.departmentGeneration,
        departmentRows,
        communeRows,
      }),
    };
  }

  private async assertCanContinue(
    claim: HistoricBackfillTaskClaim,
    signal: AbortSignal,
  ): Promise<void> {
    this.throwIfAborted(signal);
    if (await this.currentPriority.shouldYield(claim)) {
      throw new HistoricBackfillTaskInterruptedError(
        'current-priority',
        'Historic backfill yielded to current computation',
      );
    }
    await this.assertExecutionContext(claim);
    this.throwIfAborted(signal);
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new HistoricBackfillTaskInterruptedError(
        'aborted',
        'Historic backfill task was aborted',
      );
    }
  }

  private async assertExecutionContext(
    claim: HistoricBackfillTaskClaim,
  ): Promise<void> {
    const [row] = await this.dataSource.query(
      `
        SELECT
          revision."generation"::text AS "generation",
          EXISTS (
            SELECT 1
            FROM "historic_backfill_task" task
            JOIN "historic_backfill_run" run ON run."id" = task."runId"
            CROSS JOIN "config" config
            WHERE task."runId" = $1::uuid
              AND task."departementId" = $2::integer
              AND task."status" = 'leased'
              AND task."leaseOwner" = $3
              AND task."leaseToken" = $4::uuid
              AND task."leaseExpiresAt" > now()
              AND task."departmentGeneration" = revision."generation"
              AND run."status" = 'running'
              AND run."historicComputeEpoch" = $5::bigint
              AND config."id" = 1
              AND config."historicComputeEpoch" = run."historicComputeEpoch"
              AND run."historicBackfillGlobalEpoch" =
                config."historicBackfillGlobalEpoch"
          ) AS "contextMatches"
        FROM "historic_backfill_department_revision" revision
        WHERE revision."departementId" = $2::integer
      `,
      [
        claim.runId,
        claim.departementId,
        claim.workerId,
        claim.leaseToken,
        claim.historicComputeEpoch,
      ],
    );
    if (row?.generation !== claim.departmentGeneration) {
      throw new HistoricBackfillTaskInterruptedError(
        'generation-changed',
        `Historic backfill department generation changed for ${claim.departementCode}`,
      );
    }
    if (!databaseBoolean(row?.contextMatches)) {
      throw new HistoricBackfillTaskInterruptedError(
        'aborted',
        `Historic backfill lease or epoch was lost for ${claim.departementCode}`,
      );
    }
  }

  private async throwLostContext(
    claim: HistoricBackfillTaskClaim,
  ): Promise<never> {
    await this.assertExecutionContext(claim);
    throw new HistoricBackfillTaskInterruptedError(
      'aborted',
      `Historic backfill lease was lost for ${claim.departementCode}`,
    );
  }
}
