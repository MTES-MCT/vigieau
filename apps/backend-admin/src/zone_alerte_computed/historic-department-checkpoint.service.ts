import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Departement } from '@shared/entities/departement.entity';
import { createHash } from 'node:crypto';
import moment, { Moment } from 'moment';
import { DataSource } from 'typeorm';
import { ArreteRestrictionService } from '../arrete_restriction/arrete_restriction.service';

export const HISTORIC_DEPARTMENT_CHECKPOINT_ENV =
  'HISTORIC_DEPARTMENT_CHECKPOINT_ENABLED';
export const HISTORIC_DEPARTMENT_SIGNATURE_VERSION = 1;
export const HISTORIC_DEPARTMENT_CHECKPOINT_PURGE_BATCH_SIZE = 5_000;

type CheckpointReason =
  | 'disabled'
  | 'missing_compute_epoch'
  | 'missing_source_revision'
  | 'resume'
  | 'unchanged_from_previous_day'
  | 'recompute';

interface CheckpointRow {
  computedFor: string | Date;
  outputSignature: string;
  zoneCount: string | number;
}

interface OutputFingerprint {
  signature: string;
  zoneCount: number;
}

export interface HistoricDepartmentCheckpointOptions {
  date: Moment;
  previousDate: string | null;
  historicComputeEpoch?: string;
  expectedSourceRevision?: string;
}

export interface HistoricDepartmentCheckpointContext {
  historicComputeEpoch?: string;
  expectedSourceRevision?: string;
}

export interface HistoricDepartmentCheckpointPlan {
  enabled: boolean;
  shouldCompute: boolean;
  reason: CheckpointReason;
  inputSignature?: string;
  materializationVersion?: string;
}

export function isHistoricDepartmentCheckpointEnabled(
  value = process.env[HISTORIC_DEPARTMENT_CHECKPOINT_ENV],
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new Error(
    `${HISTORIC_DEPARTMENT_CHECKPOINT_ENV} must be "true" or "false"`,
  );
}

export function getHistoricDepartmentMaterializationVersion(
  skipCommuneIntersections = readSkipCommuneIntersectionsMode(),
): string {
  return [
    `historic-department-v${HISTORIC_DEPARTMENT_SIGNATURE_VERSION}`,
    skipCommuneIntersections
      ? 'commune-links-skipped'
      : 'commune-links-materialized',
  ].join(':');
}

export function createHistoricDepartmentSourceSignature(source: unknown) {
  return sha256(stableStringify(source));
}

@Injectable()
export class HistoricDepartmentCheckpointService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => ArreteRestrictionService))
    private readonly arreteRestrictionService: ArreteRestrictionService,
  ) {}

  async purgeStaleCheckpoints(
    context: HistoricDepartmentCheckpointContext,
  ): Promise<number> {
    if (
      !isHistoricDepartmentCheckpointEnabled() ||
      context.historicComputeEpoch === undefined ||
      context.expectedSourceRevision === undefined
    ) {
      return 0;
    }

    const [result] = await this.dataSource.query(
      `
        WITH current_context AS (
          SELECT 1
          FROM "config" config
          CROSS JOIN "zone_publication_source_state" source_state
          WHERE config."id" = 1
            AND config."historicComputeEpoch" = $1::bigint
            AND source_state."id" = 1
            AND source_state."revision"::text = $2::text
        ), stale_checkpoints AS (
          SELECT checkpoint.ctid
          FROM "historic_department_checkpoint" checkpoint
          WHERE EXISTS (SELECT 1 FROM current_context)
            AND (
              checkpoint."historicComputeEpoch" <> $1::bigint
              OR checkpoint."sourceRevision" <> $2::text
            )
          ORDER BY
            checkpoint."completedAt",
            checkpoint."computedFor",
            checkpoint."departementId"
          LIMIT $3
        ), deleted_checkpoints AS (
          DELETE FROM "historic_department_checkpoint" checkpoint
          USING stale_checkpoints
          WHERE checkpoint.ctid = stale_checkpoints.ctid
          RETURNING 1
        )
        SELECT
          EXISTS (SELECT 1 FROM current_context) AS "contextMatches",
          COUNT(*)::integer AS "deletedCount"
        FROM deleted_checkpoints
      `,
      [
        context.historicComputeEpoch,
        context.expectedSourceRevision,
        HISTORIC_DEPARTMENT_CHECKPOINT_PURGE_BATCH_SIZE,
      ],
    );
    this.assertGuardedWorkerContext(
      result,
      context.historicComputeEpoch,
      context.expectedSourceRevision,
    );
    return Number(result.deletedCount ?? 0);
  }

  async hasAnyCheckpointForDate(
    date: Moment,
    completedSnapshotDate: Moment,
    context: HistoricDepartmentCheckpointContext,
  ): Promise<boolean> {
    if (
      !isHistoricDepartmentCheckpointEnabled() ||
      context.historicComputeEpoch === undefined ||
      context.expectedSourceRevision === undefined
    ) {
      return false;
    }

    const materializationVersion =
      getHistoricDepartmentMaterializationVersion();
    const [result] = await this.dataSource.query(
      `
        SELECT
          EXISTS (
            SELECT 1
            FROM "config" config
            CROSS JOIN "zone_publication_source_state" source_state
            WHERE config."id" = 1
              AND config."historicComputeEpoch" = $2::bigint
              AND source_state."id" = 1
              AND source_state."revision"::text = $3::text
          ) AS "contextMatches",
          EXISTS (
            SELECT 1
            FROM "historic_department_checkpoint" checkpoint
            WHERE checkpoint."computedFor" = $1::date
              AND checkpoint."historicComputeEpoch" = $2::bigint
              AND checkpoint."sourceRevision" = $3::text
              AND checkpoint."materializationVersion" = $4
          ) AS "hasCheckpoint",
          EXISTS (
            SELECT 1
            FROM "statistic_commune_snapshot" snapshot
            WHERE snapshot."snapshotDate" = $5::date
              AND snapshot."scope" = 'national'
              AND snapshot."status" = 'completed'
              AND snapshot."sourceRevision" = $3::bigint
          ) AS "snapshotCompleted"
      `,
      [
        date.format('YYYY-MM-DD'),
        context.historicComputeEpoch,
        context.expectedSourceRevision,
        materializationVersion,
        completedSnapshotDate.format('YYYY-MM-DD'),
      ],
    );
    this.assertGuardedWorkerContext(
      result,
      context.historicComputeEpoch,
      context.expectedSourceRevision,
    );
    return result.hasCheckpoint === true && result.snapshotCompleted === true;
  }

  async prepare(
    departement: Departement,
    options: HistoricDepartmentCheckpointOptions,
  ): Promise<HistoricDepartmentCheckpointPlan> {
    if (!isHistoricDepartmentCheckpointEnabled()) {
      return this.computePlan('disabled');
    }
    if (options.expectedSourceRevision === undefined) {
      return this.computePlan('missing_source_revision');
    }
    if (options.historicComputeEpoch === undefined) {
      return this.computePlan('missing_compute_epoch');
    }

    const computedFor = options.date.format('YYYY-MM-DD');
    const materializationVersion =
      getHistoricDepartmentMaterializationVersion();
    const inputSignature = await this.computeInputSignature(
      departement,
      options.date,
      options.expectedSourceRevision,
      materializationVersion,
    );
    let currentOutput: OutputFingerprint | undefined;
    const outputMatches = async (checkpoint: CheckpointRow | undefined) => {
      if (!checkpoint) {
        return false;
      }
      currentOutput ??= await this.computeOutputFingerprint(departement.id);
      return (
        checkpoint.outputSignature === currentOutput.signature &&
        Number(checkpoint.zoneCount) === currentOutput.zoneCount
      );
    };

    const exactCheckpoint = await this.findExactCheckpoint(
      departement.id,
      computedFor,
      options.historicComputeEpoch,
      options.expectedSourceRevision,
      materializationVersion,
      inputSignature,
    );
    if (await outputMatches(exactCheckpoint)) {
      await this.assertCurrentCheckpointContext(
        options.historicComputeEpoch,
        options.expectedSourceRevision,
        departement.code,
      );
      return {
        enabled: true,
        shouldCompute: false,
        reason: 'resume',
        inputSignature,
        materializationVersion,
      };
    }

    if (this.isPreviousDay(options.previousDate, computedFor)) {
      const previousCheckpoint = await this.findReusableCheckpoint(
        departement.id,
        options.previousDate,
        options.historicComputeEpoch,
        options.expectedSourceRevision,
        materializationVersion,
        inputSignature,
      );
      if (await outputMatches(previousCheckpoint)) {
        await this.assertCurrentCheckpointContext(
          options.historicComputeEpoch,
          options.expectedSourceRevision,
          departement.code,
        );
        await this.saveCheckpoint(
          departement.id,
          computedFor,
          options.historicComputeEpoch,
          options.expectedSourceRevision,
          materializationVersion,
          inputSignature,
          currentOutput!,
          options.previousDate,
        );
        return {
          enabled: true,
          shouldCompute: false,
          reason: 'unchanged_from_previous_day',
          inputSignature,
          materializationVersion,
        };
      }
    }

    return {
      enabled: true,
      shouldCompute: true,
      reason: 'recompute',
      inputSignature,
      materializationVersion,
    };
  }

  async complete(
    departement: Departement,
    options: HistoricDepartmentCheckpointOptions,
    plan: HistoricDepartmentCheckpointPlan,
  ): Promise<void> {
    if (
      !plan.enabled ||
      !plan.shouldCompute ||
      !plan.inputSignature ||
      !plan.materializationVersion ||
      options.historicComputeEpoch === undefined ||
      options.expectedSourceRevision === undefined
    ) {
      return;
    }

    await this.assertCurrentCheckpointContext(
      options.historicComputeEpoch,
      options.expectedSourceRevision,
      departement.code,
    );
    const currentInputSignature = await this.computeInputSignature(
      departement,
      options.date,
      options.expectedSourceRevision,
      plan.materializationVersion,
    );
    if (currentInputSignature !== plan.inputSignature) {
      throw new Error(
        `Historic source signature changed while computing department ${departement.code} on ${options.date.format('YYYY-MM-DD')}`,
      );
    }

    const output = await this.computeOutputFingerprint(departement.id);
    await this.saveCheckpoint(
      departement.id,
      options.date.format('YYYY-MM-DD'),
      options.historicComputeEpoch,
      options.expectedSourceRevision,
      plan.materializationVersion,
      plan.inputSignature,
      output,
      null,
    );
  }

  private computePlan(
    reason: CheckpointReason,
  ): HistoricDepartmentCheckpointPlan {
    return { enabled: false, shouldCompute: true, reason };
  }

  private assertGuardedWorkerContext(
    result:
      | {
          contextMatches?: boolean;
          deletedCount?: number | string;
          hasCheckpoint?: boolean;
          snapshotCompleted?: boolean;
        }
      | undefined,
    expectedHistoricComputeEpoch: string,
    expectedSourceRevision: string,
  ): asserts result is {
    contextMatches: true;
    deletedCount?: number | string;
    hasCheckpoint?: boolean;
    snapshotCompleted?: boolean;
  } {
    if (result?.contextMatches !== true) {
      throw new Error(
        `Historic checkpoint worker context changed (epoch=${expectedHistoricComputeEpoch}, sourceRevision=${expectedSourceRevision})`,
      );
    }
  }

  private async computeInputSignature(
    departement: Departement,
    date: Moment,
    sourceRevision: string,
    materializationVersion: string,
  ): Promise<string> {
    const arretes =
      await this.arreteRestrictionService.findByDepartementAndDate(
        departement.code,
        date,
      );
    const activeParameter = departement.parametres?.find(
      (parameter) =>
        date.isSameOrAfter(moment(parameter.dateDebut)) &&
        (!parameter.dateFin || date.isSameOrBefore(moment(parameter.dateFin))),
    );

    return createHistoricDepartmentSourceSignature({
      materializationVersion,
      sourceRevision,
      departement: {
        id: departement.id,
        code: departement.code,
        superpositionCommune: activeParameter?.superpositionCommune ?? null,
      },
      arretes: arretes
        .map((arrete) => ({
          id: arrete.id,
          niveauGraviteSpecifiqueEap: arrete.niveauGraviteSpecifiqueEap ?? null,
          ressourceEapCommunique: arrete.ressourceEapCommunique ?? null,
          restrictions: (arrete.restrictions ?? [])
            .map((restriction) => ({
              id: restriction.id,
              nomGroupementAep: restriction.nomGroupementAep ?? null,
              niveauGravite: restriction.niveauGravite ?? null,
              arreteCadreId: restriction.arreteCadre?.id ?? null,
              zoneAlerte: restriction.zoneAlerte
                ? {
                    id: restriction.zoneAlerte.id,
                    code: restriction.zoneAlerte.code,
                    nom: restriction.zoneAlerte.nom,
                    type: restriction.zoneAlerte.type,
                    disabled: restriction.zoneAlerte.disabled,
                  }
                : null,
              communeIds: (restriction.communes ?? [])
                .map((commune) => commune.id)
                .sort((left, right) => left - right),
            }))
            .sort((left, right) => left.id - right.id),
        }))
        .sort((left, right) => left.id - right.id),
    });
  }

  private isPreviousDay(previousDate: string | null, computedFor: string) {
    if (!previousDate) {
      return false;
    }
    const previous = moment(previousDate, 'YYYY-MM-DD', true);
    const current = moment(computedFor, 'YYYY-MM-DD', true);
    return (
      previous.isValid() &&
      current.isValid() &&
      current.diff(previous, 'days') === 1
    );
  }

  private async findExactCheckpoint(
    departementId: number,
    computedFor: string,
    historicComputeEpoch: string,
    sourceRevision: string,
    materializationVersion: string,
    inputSignature: string,
  ): Promise<CheckpointRow | undefined> {
    const [row] = (await this.dataSource.query(
      `
        SELECT "computedFor", "outputSignature", "zoneCount"
        FROM "historic_department_checkpoint"
        WHERE "departementId" = $1
          AND "computedFor" = $2::date
          AND "historicComputeEpoch" = $3::bigint
          AND "sourceRevision" = $4
          AND "materializationVersion" = $5
          AND "inputSignature" = $6
        LIMIT 1
      `,
      [
        departementId,
        computedFor,
        historicComputeEpoch,
        sourceRevision,
        materializationVersion,
        inputSignature,
      ],
    )) as CheckpointRow[];
    return row;
  }

  private async findReusableCheckpoint(
    departementId: number,
    computedFor: string,
    historicComputeEpoch: string,
    sourceRevision: string,
    materializationVersion: string,
    inputSignature: string,
  ): Promise<CheckpointRow | undefined> {
    const [row] = (await this.dataSource.query(
      `
        SELECT "computedFor", "outputSignature", "zoneCount"
        FROM "historic_department_checkpoint"
        WHERE "departementId" = $1
          AND "computedFor" = $2::date
          AND "historicComputeEpoch" = $3::bigint
          AND "sourceRevision" = $4
          AND "materializationVersion" = $5
          AND "inputSignature" = $6
        LIMIT 1
      `,
      [
        departementId,
        computedFor,
        historicComputeEpoch,
        sourceRevision,
        materializationVersion,
        inputSignature,
      ],
    )) as CheckpointRow[];
    return row;
  }

  private async computeOutputFingerprint(
    departementId: number,
  ): Promise<OutputFingerprint> {
    const rows = await this.dataSource.query(
      `
        SELECT
          zone."id"::text AS "id",
          zone."idSandre"::text AS "idSandre",
          zone."nom" AS "nom",
          zone."code" AS "code",
          zone."type" AS "type",
          zone."ressourceInfluencee" AS "ressourceInfluencee",
          zone."niveauGravite"::text AS "niveauGravite",
          zone."restrictionId"::text AS "restrictionId",
          zone."bassinVersantId"::text AS "bassinVersantId",
          md5(ST_AsEWKB(zone."geom")) AS "geometrySignature",
          COALESCE(
            ARRAY(
              SELECT relation."communeId"::text
              FROM "zone_alerte_computed_historic_commune" relation
              WHERE relation."zoneAlerteComputedHistoricId" = zone."id"
              ORDER BY relation."communeId"
            ),
            ARRAY[]::text[]
          ) AS "communeIds"
        FROM "zone_alerte_computed_historic" zone
        WHERE zone."departementId" = $1
        ORDER BY zone."id"
      `,
      [departementId],
    );
    return {
      signature: createHistoricDepartmentSourceSignature(rows),
      zoneCount: rows.length,
    };
  }

  private async getCurrentCheckpointContext(): Promise<{
    historicComputeEpoch: string;
    sourceRevision: string;
  }> {
    const [row] = await this.dataSource.query(
      `
        SELECT
          config."historicComputeEpoch"::text AS "historicComputeEpoch",
          source_state."revision"::text AS "sourceRevision"
        FROM "config" config
        CROSS JOIN "zone_publication_source_state" source_state
        WHERE config."id" = 1
          AND source_state."id" = 1
      `,
    );
    return {
      historicComputeEpoch: row ? String(row.historicComputeEpoch) : 'missing',
      sourceRevision: row ? String(row.sourceRevision) : 'missing',
    };
  }

  private async assertCurrentCheckpointContext(
    expectedHistoricComputeEpoch: string,
    expectedSourceRevision: string,
    departementCode: string,
  ): Promise<void> {
    const current = await this.getCurrentCheckpointContext();
    if (current.historicComputeEpoch !== expectedHistoricComputeEpoch) {
      throw new Error(
        `Historic compute epoch changed while computing department ${departementCode} (${expectedHistoricComputeEpoch} -> ${current.historicComputeEpoch})`,
      );
    }
    if (current.sourceRevision !== expectedSourceRevision) {
      throw new Error(
        `Historic source revision changed while computing department ${departementCode} (${expectedSourceRevision} -> ${current.sourceRevision})`,
      );
    }
  }

  private async saveCheckpoint(
    departementId: number,
    computedFor: string,
    historicComputeEpoch: string,
    sourceRevision: string,
    materializationVersion: string,
    inputSignature: string,
    output: OutputFingerprint,
    reusedFromDate: string | null,
  ): Promise<void> {
    const saved = await this.dataSource.query(
      `
        INSERT INTO "historic_department_checkpoint" (
          "computedFor",
          "departementId",
          "historicComputeEpoch",
          "sourceRevision",
          "materializationVersion",
          "inputSignature",
          "outputSignature",
          "zoneCount",
          "reusedFromDate",
          "completedAt"
        )
        SELECT
          $1::date,
          $2,
          $3::bigint,
          $4::text,
          $5,
          $6,
          $7,
          $8,
          $9::date,
          now()
        FROM "config" config
        CROSS JOIN "zone_publication_source_state" source_state
        WHERE config."id" = 1
          AND config."historicComputeEpoch" = $3::bigint
          AND source_state."id" = 1
          AND source_state."revision"::text = $4::text
        ON CONFLICT ("computedFor", "departementId", "historicComputeEpoch")
        DO UPDATE SET
          "sourceRevision" = EXCLUDED."sourceRevision",
          "materializationVersion" = EXCLUDED."materializationVersion",
          "inputSignature" = EXCLUDED."inputSignature",
          "outputSignature" = EXCLUDED."outputSignature",
          "zoneCount" = EXCLUDED."zoneCount",
          "reusedFromDate" = EXCLUDED."reusedFromDate",
          "completedAt" = now()
        RETURNING "computedFor"
      `,
      [
        computedFor,
        departementId,
        historicComputeEpoch,
        sourceRevision,
        materializationVersion,
        inputSignature,
        output.signature,
        output.zoneCount,
        reusedFromDate,
      ],
    );
    if (saved.length !== 1) {
      throw new Error(
        `Historic checkpoint context changed while certifying department ${departementId} on ${computedFor}`,
      );
    }
  }
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function readSkipCommuneIntersectionsMode(): boolean {
  const value = process.env.HISTORIC_SKIP_COMMUNE_INTERSECTIONS;
  if (value === undefined || value.trim() === '') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new Error('HISTORIC_SKIP_COMMUNE_INTERSECTIONS must be true or false');
}
