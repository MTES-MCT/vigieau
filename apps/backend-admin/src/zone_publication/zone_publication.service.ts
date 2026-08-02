import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  buildZonePublicationAggregate,
  computeZonePublicationFingerprint,
  type ZonePublicationAggregatePayload,
  type ZonePublicationMaterializedZone,
} from '@shared/zone_publication_materialization';
import { RegleauLogger } from '../logger/regleau.logger';
import { shouldRunWebScheduledJobs } from '../core/scheduling/business-cron';
import {
  isZonePublicationEnabled,
  ZONE_PUBLICATION_MATERIALIZATION_VERSION,
  ZONE_PUBLICATION_STABLE_PROMOTION_LOCK,
} from './zone_publication.config';
import { unwrapTypeOrmDmlReturningRows } from './typeorm-query-result';

export interface ZonePublicationArtifacts {
  geojsonUrl: string;
  geojsonChecksum: string;
  pmtilesUrl: string;
  pmtilesChecksum: string;
}

export interface ActiveZonePublicationGate extends ZonePublicationArtifacts {
  publicationId: string;
  sourceRevision: string;
  sourceComputedAt: string;
}

export interface BuildZonePublicationOptions extends ZonePublicationArtifacts {
  sourceRevision: string;
  sourceComputedAt: Date;
  artifactZoneCount: number;
}

export interface DailyZonePublicationReuseContext {
  scheduledFor: string;
  sourceRevision: string;
}

export interface ReusableZonePublication {
  publicationId: string;
  sourceRevision: string;
}

export interface ZonePublicationActivationResult {
  status:
    | 'activated'
    | 'busy'
    | 'disabled'
    | 'failed'
    | 'no_candidate'
    | 'not_ready'
    | 'rollback_cancelled'
    | 'superseded';
  publicationId?: string;
  liveInstances?: number;
  readyInstances?: number;
  rollback?: boolean;
}

export interface ZonePublicationRollbackResult {
  status:
    | 'disabled'
    | 'no_active_publication'
    | 'no_target'
    | 'blocked'
    | 'candidate_pending'
    | 'dry_run'
    | 'prepared';
  activePublicationId?: string;
  targetPublicationId?: string;
  minimumReadyInstances?: number;
  liveInstances?: number;
  readyInstances?: number;
  blockers?: string[];
  pendingCandidate?: {
    id: string;
    status: string;
    replaceable: boolean;
  };
  replacedCandidatePublicationId?: string;
}

interface ZonePublicationSnapshotCounts {
  zoneCount: number;
  communeLinkCount: number;
}

export interface ZoneSourceRow {
  id: number;
  idSandre: number | null;
  code: string | null;
  nom: string;
  type: 'SOU' | 'SUP' | 'AEP';
  ressourceInfluencee: boolean;
  niveauGravite: string | null;
  departmentId: number;
  departmentCode: string;
  publicDepartmentCode: string | null;
  restrictionId: number | null;
  arreteId: number | null;
  dateDebutValidite: string | null;
  dateFinValidite: string | null;
  cheminFichier: string | null;
  cheminFichierArreteCadre: string | null;
}

export interface ZoneUsageRow {
  id: number;
  restrictionId: number;
  nom: string;
  thematique: string | null;
  concerneParticulier: boolean | null;
  concerneEntreprise: boolean | null;
  concerneCollectivite: boolean | null;
  concerneExploitation: boolean | null;
  concerneEso: boolean;
  concerneEsu: boolean;
  concerneAep: boolean;
  descriptionVigilance: string | null;
  descriptionAlerte: string | null;
  descriptionAlerteRenforcee: string | null;
  descriptionCrise: string | null;
}

const PUBLICATION_ACTIVATION_INTERVAL_MS = 10_000;
const PUBLICATION_RECOVERY_INTERVAL_MS = 60_000;
const PUBLICATION_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

export function computeZonePublicationRetryBackoffSeconds(
  failureCount: number,
  baseSeconds: number,
  maxSeconds: number,
): number {
  if (!Number.isInteger(failureCount) || failureCount <= 0) {
    return 0;
  }

  let backoffSeconds = Math.min(baseSeconds, maxSeconds);
  for (
    let failureIndex = 1;
    failureIndex < failureCount && backoffSeconds < maxSeconds;
    failureIndex += 1
  ) {
    backoffSeconds = Math.min(backoffSeconds * 2, maxSeconds);
  }
  return backoffSeconds;
}

function descriptionForLevel(
  usage: ZoneUsageRow,
  level: string | null,
): string | null {
  switch (level) {
    case 'vigilance':
      return usage.descriptionVigilance;
    case 'alerte':
      return usage.descriptionAlerte;
    case 'alerte_renforcee':
      return usage.descriptionAlerteRenforcee;
    case 'crise':
      return usage.descriptionCrise;
    default:
      return '';
  }
}

export function buildZonePublicPayload(
  zone: ZoneSourceRow,
  usages: ZoneUsageRow[],
): Record<string, unknown> {
  const filteredUsages = usages.filter((usage) => {
    if (zone.type === 'SUP') {
      return usage.concerneEsu;
    }
    if (zone.type === 'SOU') {
      return usage.concerneEso;
    }
    if (zone.type === 'AEP') {
      return usage.concerneAep;
    }
    return true;
  });

  const payload = {
    id: zone.id,
    idSandre: zone.idSandre,
    code: zone.code,
    nom: zone.nom,
    type: zone.type,
    ressourceInfluencee: zone.ressourceInfluencee,
    niveauGravite: zone.niveauGravite,
    departement: zone.restrictionId
      ? (zone.publicDepartmentCode ?? undefined)
      : undefined,
    arrete: zone.restrictionId
      ? {
          id: zone.arreteId,
          dateDebutValidite: zone.dateDebutValidite,
          dateFinValidite: zone.dateFinValidite,
          cheminFichier: zone.cheminFichier ?? undefined,
          cheminFichierArreteCadre: zone.cheminFichierArreteCadre ?? undefined,
        }
      : {},
    usages: zone.restrictionId
      ? filteredUsages.map((usage) => ({
          id: usage.id,
          nom: usage.nom,
          thematique: usage.thematique ?? undefined,
          description: descriptionForLevel(usage, zone.niveauGravite),
          concerneParticulier: usage.concerneParticulier,
          concerneEntreprise: usage.concerneEntreprise,
          concerneCollectivite: usage.concerneCollectivite,
          concerneExploitation: usage.concerneExploitation,
        }))
      : undefined,
  };

  // JSON serialization reproduces the current API behavior for undefined fields.
  return JSON.parse(JSON.stringify(payload));
}

@Injectable()
export class ZonePublicationService {
  private readonly logger = new RegleauLogger('ZonePublicationService');
  private activationInProgress = false;
  private recoveryInProgress = false;
  private retentionInProgress = false;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async getSourceRevision(): Promise<string> {
    const [state] = await this.dataSource.query(
      `SELECT "revision" FROM "zone_publication_source_state" WHERE "id" = 1`,
    );
    if (!state) {
      throw new Error('Zone publication source state is missing');
    }
    return String(state.revision);
  }

  async findReusableDailyPublication(
    context: DailyZonePublicationReuseContext,
  ): Promise<ReusableZonePublication | null> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(context.scheduledFor)) {
      throw new Error(
        `Invalid daily zone publication date: ${context.scheduledFor}`,
      );
    }
    if (!/^\d+$/.test(context.sourceRevision)) {
      throw new Error(
        `Invalid daily zone publication source revision: ${context.sourceRevision}`,
      );
    }
    const [publication] = await this.dataSource.query(
      `
        SELECT
          publication."id" AS "publicationId",
          publication."sourceRevision"
        FROM "zone_publication_state" state
        JOIN "zone_publication_source_state" source ON source."id" = 1
        JOIN "zone_publication" publication
          ON publication."id" IN (
            state."activePublicationId",
            state."candidatePublicationId"
          )
        WHERE state."id" = 1
          AND source."revision" = $1
          AND publication."sourceRevision" = source."revision"
          AND publication."materializationVersion" = $2
          AND (
            (publication."id" = state."candidatePublicationId"
              AND publication."status" = 'candidate')
            OR
            (publication."id" = state."activePublicationId"
              AND publication."status" = 'active')
          )
          AND publication."validatedAt" IS NOT NULL
          AND publication."contentFingerprint" IS NOT NULL
          AND publication."validationReport" IS NOT NULL
          AND publication."geojsonUrl" IS NOT NULL
          AND publication."geojsonChecksum" IS NOT NULL
          AND publication."pmtilesUrl" IS NOT NULL
          AND publication."pmtilesChecksum" IS NOT NULL
          AND (publication."sourceComputedAt" AT TIME ZONE 'Europe/Paris')::date = $3::date
          AND EXISTS (
            SELECT 1
            FROM "zone_publication_aggregate" aggregate
            WHERE aggregate."publicationId" = publication."id"
          )
        ORDER BY
          CASE
            WHEN publication."id" = state."candidatePublicationId" THEN 0
            ELSE 1
          END
        LIMIT 1
      `,
      [
        context.sourceRevision,
        ZONE_PUBLICATION_MATERIALIZATION_VERSION,
        context.scheduledFor,
      ],
    );
    if (!publication) {
      return null;
    }
    return {
      publicationId: String(publication.publicationId),
      sourceRevision: String(publication.sourceRevision),
    };
  }

  async getActivePublicationGate(
    scheduledFor: string,
  ): Promise<ActiveZonePublicationGate | null> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledFor)) {
      throw new Error(`Invalid publication gate date: ${scheduledFor}`);
    }
    const [publication] = await this.dataSource.query(
      `
        SELECT
          publication."id" AS "publicationId",
          publication."sourceRevision",
          publication."sourceComputedAt",
          publication."geojsonUrl",
          publication."geojsonChecksum",
          publication."pmtilesUrl",
          publication."pmtilesChecksum"
        FROM "zone_publication_state" state
        JOIN "zone_publication" publication
          ON publication."id" = state."activePublicationId"
        JOIN "zone_publication_source_state" source ON source."id" = 1
        WHERE state."id" = 1
          AND publication."status" = 'active'
          AND publication."sourceRevision" = source."revision"
          AND (publication."sourceComputedAt" AT TIME ZONE 'Europe/Paris')::date = $1::date
          AND publication."legacyPromotedAt" IS NOT NULL
          AND publication."dataGouvPromotedAt" IS NOT NULL
          AND publication."geojsonUrl" IS NOT NULL
          AND publication."geojsonChecksum" IS NOT NULL
          AND publication."pmtilesUrl" IS NOT NULL
          AND publication."pmtilesChecksum" IS NOT NULL
        LIMIT 1
      `,
      [scheduledFor],
    );
    if (!publication) {
      return null;
    }
    const sourceComputedAt = new Date(publication.sourceComputedAt);
    if (Number.isNaN(sourceComputedAt.getTime())) {
      throw new Error(
        `Active publication ${publication.publicationId} has an invalid computation date`,
      );
    }
    return {
      publicationId: publication.publicationId,
      sourceRevision: String(publication.sourceRevision),
      sourceComputedAt: sourceComputedAt.toISOString(),
      geojsonUrl: publication.geojsonUrl,
      geojsonChecksum: publication.geojsonChecksum,
      pmtilesUrl: publication.pmtilesUrl,
      pmtilesChecksum: publication.pmtilesChecksum,
    };
  }

  async bumpSourceRevision(): Promise<string> {
    const result = await this.dataSource.query(`
      UPDATE "zone_publication_source_state"
      SET "revision" = "revision" + 1, "updatedAt" = now()
      WHERE "id" = 1
      RETURNING "revision"
    `);
    const [state] = unwrapTypeOrmDmlReturningRows<{ revision: string }>(result);
    if (!state) {
      throw new Error('Zone publication source state is missing');
    }
    return String(state.revision);
  }

  async buildCandidateFromCurrentComputed(
    options: BuildZonePublicationOptions,
  ): Promise<string> {
    if (!isZonePublicationEnabled()) {
      throw new Error('Zone publication is disabled');
    }
    const publicationId = randomUUID();

    try {
      this.assertArtifacts(options);
      await this.verifyPublicArtifacts(options);
      await this.dataSource.transaction('REPEATABLE READ', async (manager) => {
        await this.assertCurrentSourceRevision(manager, options.sourceRevision);
        await this.insertBuildingPublication(manager, publicationId, options);

        const zones = await this.loadSourceZones(manager);
        const usages = await this.loadSourceUsages(manager, zones);
        const usagesByRestriction = new Map<number, ZoneUsageRow[]>();
        for (const usage of usages) {
          const restrictionUsages =
            usagesByRestriction.get(usage.restrictionId) || [];
          restrictionUsages.push(usage);
          usagesByRestriction.set(usage.restrictionId, restrictionUsages);
        }

        const snapshotRows = zones.map((zone) => ({
          sourceZoneId: zone.id,
          departmentId: zone.departmentId,
          departmentCode: zone.departmentCode,
          type: zone.type,
          publicPayload: buildZonePublicPayload(
            zone,
            usagesByRestriction.get(zone.restrictionId) || [],
          ),
        }));
        await this.insertSnapshotZones(manager, publicationId, snapshotRows);
        await this.insertComputedCommuneLinks(manager, publicationId);

        const counts = await this.validateSnapshot(manager, publicationId);
        if (counts.zoneCount !== options.artifactZoneCount) {
          throw new Error(
            `Zone publication artifact contains ${options.artifactZoneCount} zones but snapshot contains ${counts.zoneCount}`,
          );
        }
        await this.assertPlausibleSnapshot(manager, counts);
        const aggregate = buildZonePublicationAggregate(
          snapshotRows.map((row) => row.publicPayload),
          counts.communeLinkCount,
        );
        await this.insertAggregate(manager, publicationId, aggregate);
        const contentFingerprint = await this.computeMaterializationFingerprint(
          manager,
          publicationId,
          aggregate,
        );
        const validationReport = {
          schemaVersion: 1,
          validatedAt: new Date().toISOString(),
          checks: {
            artifacts: 'passed',
            snapshotStructure: 'passed',
            semanticPayload: 'passed',
            communeLinks: 'passed',
            plausibility: 'passed',
            aggregate: 'passed',
            fingerprint: 'passed',
          },
          counts: aggregate.counts,
          departmentCount: Object.keys(aggregate.departments).length,
          contentFingerprint,
        };
        const validated = unwrapTypeOrmDmlReturningRows<{ id: string }>(
          await manager.query(
            `
              UPDATE "zone_publication"
              SET "status" = 'validated',
                  "validatedAt" = now(),
                  "zoneCount" = $2,
                  "communeLinkCount" = $3,
                  "departmentCount" = $4,
                  "contentFingerprint" = $5,
                  "validationReport" = $6
              WHERE "id" = $1 AND "status" = 'building'
              RETURNING "id"
          `,
            [
              publicationId,
              counts.zoneCount,
              counts.communeLinkCount,
              Object.keys(aggregate.departments).length,
              contentFingerprint,
              validationReport,
            ],
          ),
        );
        if (validated.length !== 1) {
          throw new Error(
            `Unable to validate zone publication ${publicationId}`,
          );
        }
      });
    } catch (error) {
      await this.recordFailedPublication(publicationId, options, error);
      throw error;
    }

    let marked: boolean;
    try {
      marked = await this.markCandidateWithRetry(publicationId);
    } catch (error) {
      await this.failValidatedPublication(publicationId, error);
      throw error;
    }
    if (!marked) {
      throw new Error(
        `Zone publication ${publicationId} was superseded before candidacy`,
      );
    }
    this.logger.log(`Zone publication ${publicationId} is ready for preload`);
    return publicationId;
  }

  async isRecomputeRequired(
    retrySeconds = this.readPositiveInteger(
      'ZONE_PUBLICATION_RETRY_BACKOFF_SECONDS',
      300,
    ),
    inProgressTimeoutSeconds = this.readPositiveInteger(
      'ZONE_PUBLICATION_ORPHAN_TIMEOUT_SECONDS',
      75 * 60,
    ),
    maxRetrySeconds = this.readPositiveInteger(
      'ZONE_PUBLICATION_RETRY_MAX_BACKOFF_SECONDS',
      6 * 60 * 60,
    ),
  ): Promise<boolean> {
    if (!isZonePublicationEnabled()) {
      return false;
    }
    const [status] = await this.dataSource.query(
      `
        SELECT
          source."revision" AS "sourceRevision",
          active."sourceRevision" AS "activeRevision",
          active."materializationVersion" AS "activeMaterializationVersion",
          candidate."sourceRevision" AS "candidateRevision",
          candidate."materializationVersion" AS "candidateMaterializationVersion",
          state."automaticPublishingPaused" AS "automaticPublishingPaused",
          failures."failureCount" AS "failureCount",
          failures."lastFailureAt" AS "lastFailureAt",
          now() AS "databaseNow",
          EXISTS (
            SELECT 1
            FROM "zone_publication" in_progress
            WHERE in_progress."sourceRevision" = source."revision"
              AND in_progress."materializationVersion" = $2
              AND in_progress."status" IN ('building', 'validated')
              AND in_progress."createdAt" >= now() - ($1 * interval '1 second')
          ) AS "recentInProgress"
        FROM "zone_publication_source_state" source
        INNER JOIN "zone_publication_state" state ON state."id" = 1
        LEFT JOIN "zone_publication" active
          ON active."id" = state."activePublicationId"
        LEFT JOIN "zone_publication" candidate
          ON candidate."id" = state."candidatePublicationId"
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::integer AS "failureCount",
            MAX(COALESCE(failed."failedAt", failed."createdAt")) AS "lastFailureAt"
          FROM "zone_publication" failed
          WHERE failed."sourceRevision" = source."revision"
            AND failed."materializationVersion" = $2
            AND failed."status" = 'failed'
        ) failures ON true
        WHERE source."id" = 1
      `,
      [inProgressTimeoutSeconds, ZONE_PUBLICATION_MATERIALIZATION_VERSION],
    );
    if (!status) {
      throw new Error('Zone publication state is missing');
    }
    if (status.automaticPublishingPaused === true) {
      return false;
    }
    const sourceRevision = String(status.sourceRevision);
    const activeIsCurrent =
      String(status.activeRevision ?? '') === sourceRevision &&
      Number(status.activeMaterializationVersion) ===
        ZONE_PUBLICATION_MATERIALIZATION_VERSION;
    const candidateIsCurrent =
      String(status.candidateRevision ?? '') === sourceRevision &&
      Number(status.candidateMaterializationVersion) ===
        ZONE_PUBLICATION_MATERIALIZATION_VERSION;
    const failureCount = Number.parseInt(String(status.failureCount ?? 0), 10);
    const failureBackoffSeconds = computeZonePublicationRetryBackoffSeconds(
      failureCount,
      retrySeconds,
      maxRetrySeconds,
    );
    let failureBackoffActive = false;
    if (failureCount > 0) {
      const lastFailureAt = new Date(status.lastFailureAt).getTime();
      const databaseNow = new Date(status.databaseNow).getTime();
      if (!Number.isFinite(lastFailureAt) || !Number.isFinite(databaseNow)) {
        throw new Error('Zone publication failure backoff state is invalid');
      }
      failureBackoffActive =
        databaseNow - lastFailureAt < failureBackoffSeconds * 1000;
    }
    return (
      !activeIsCurrent &&
      !candidateIsCurrent &&
      !failureBackoffActive &&
      status.recentInProgress !== true
    );
  }

  async markCandidate(publicationId: string): Promise<boolean> {
    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const [sourceState] = await manager.query(
        `SELECT "revision" FROM "zone_publication_source_state" WHERE "id" = 1 FOR UPDATE`,
      );
      const [state] = await manager.query(`
        SELECT state.*,
               candidate."status" AS "candidateStatus"
        FROM "zone_publication_state" state
        LEFT JOIN "zone_publication" candidate
          ON candidate."id" = state."candidatePublicationId"
        WHERE state."id" = 1
        FOR UPDATE OF state
      `);
      const [publication] = await manager.query(
        `SELECT * FROM "zone_publication" WHERE "id" = $1 FOR UPDATE`,
        [publicationId],
      );
      if (!publication || publication.status !== 'validated') {
        throw new Error(
          `Publication ${publicationId} is not available for candidacy`,
        );
      }
      if (
        state.automaticPublishingPaused === true ||
        state.candidateStatus === 'retired'
      ) {
        await manager.query(
          `UPDATE "zone_publication" SET "status" = 'superseded' WHERE "id" = $1 AND "status" = 'validated'`,
          [publicationId],
        );
        return false;
      }
      if (String(sourceState.revision) !== String(publication.sourceRevision)) {
        await manager.query(
          `UPDATE "zone_publication" SET "status" = 'superseded' WHERE "id" = $1`,
          [publicationId],
        );
        return false;
      }
      if (
        Number(publication.materializationVersion) !==
        ZONE_PUBLICATION_MATERIALIZATION_VERSION
      ) {
        await manager.query(
          `UPDATE "zone_publication" SET "status" = 'superseded' WHERE "id" = $1`,
          [publicationId],
        );
        return false;
      }

      if (
        state.candidatePublicationId &&
        state.candidatePublicationId !== publicationId &&
        state.candidatePublicationId !== state.activePublicationId
      ) {
        await manager.query(
          `
            UPDATE "zone_publication"
            SET "status" = 'superseded'
            WHERE "id" = $1 AND "status" IN ('validated', 'candidate')
          `,
          [state.candidatePublicationId],
        );
      }
      const marked = unwrapTypeOrmDmlReturningRows<{ id: string }>(
        await manager.query(
          `
            UPDATE "zone_publication"
            SET "status" = 'candidate', "candidateAt" = now()
            WHERE "id" = $1 AND "status" = 'validated'
            RETURNING "id"
          `,
          [publicationId],
        ),
      );
      if (marked.length !== 1) {
        throw new Error(
          `Unable to mark publication ${publicationId} candidate`,
        );
      }
      await manager.query(
        `
          UPDATE "zone_publication_state"
          SET "candidatePublicationId" = $1,
              "candidateRequestedAt" = now(),
              "updatedAt" = now()
          WHERE "id" = 1
        `,
        [publicationId],
      );
      return true;
    });
  }

  private async markCandidateWithRetry(
    publicationId: string,
    maxAttempts = 3,
    retryDelayMs = 50,
  ): Promise<boolean> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.markCandidate(publicationId);
      } catch (error) {
        lastError = error;
        if (
          !this.isRetryableTransactionError(error) ||
          attempt >= maxAttempts
        ) {
          throw error;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, retryDelayMs * 2 ** (attempt - 1)),
        );
      }
    }
    throw lastError;
  }

  private isRetryableTransactionError(error: unknown): boolean {
    const candidate = error as {
      code?: string;
      driverError?: { code?: string };
    };
    const code = candidate?.code ?? candidate?.driverError?.code;
    return code === '40001' || code === '40P01';
  }

  private async failValidatedPublication(
    publicationId: string,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.dataSource.query(
          `
            UPDATE "zone_publication"
            SET "status" = 'failed',
                "failedAt" = now(),
                "validationError" = $2
            WHERE "id" = $1 AND "status" = 'validated'
          `,
          [publicationId, message.slice(0, 10_000)],
        );
        return;
      } catch (recordError) {
        lastError = recordError;
        if (!this.isRetryableTransactionError(recordError) || attempt === 3) {
          break;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, 50 * 2 ** (attempt - 1)),
        );
      }
    }
    this.logger.error(
      'UNABLE TO FAIL VALIDATED ZONE PUBLICATION',
      lastError instanceof Error ? lastError.toString() : String(lastError),
    );
  }

  async acknowledgeCandidate(input: {
    instanceId: string;
    publicationId: string;
    zoneCount: number;
    communeLinkCount: number;
    contentFingerprint?: string | null;
    error?: string | null;
  }): Promise<void> {
    await this.dataSource.query(
      `
        INSERT INTO "zone_publication_instance" (
          "instanceId", "candidatePublicationId", "zoneCount",
          "communeLinkCount", "contentFingerprint", "lastError", "heartbeatAt"
        ) VALUES ($1, $2, $3, $4, $5, $6, now())
        ON CONFLICT ("instanceId") DO UPDATE SET
          "candidatePublicationId" = EXCLUDED."candidatePublicationId",
          "zoneCount" = EXCLUDED."zoneCount",
          "communeLinkCount" = EXCLUDED."communeLinkCount",
          "contentFingerprint" = EXCLUDED."contentFingerprint",
          "lastError" = EXCLUDED."lastError",
          "heartbeatAt" = EXCLUDED."heartbeatAt"
      `,
      [
        input.instanceId,
        input.publicationId,
        input.zoneCount,
        input.communeLinkCount,
        input.contentFingerprint || null,
        input.error || null,
      ],
    );
  }

  async activateWhenReady(input?: {
    minimumReadyInstances?: number;
    leaseSeconds?: number;
    candidateTimeoutSeconds?: number;
  }): Promise<ZonePublicationActivationResult> {
    if (!isZonePublicationEnabled()) {
      return { status: 'disabled' };
    }
    const minimumReadyInstances =
      input?.minimumReadyInstances ??
      this.readPositiveInteger('ZONE_PUBLICATION_MIN_READY_INSTANCES', 2);
    const leaseSeconds =
      input?.leaseSeconds ??
      this.readPositiveInteger('ZONE_PUBLICATION_INSTANCE_LEASE_SECONDS', 30);
    const candidateTimeoutSeconds =
      input?.candidateTimeoutSeconds ??
      this.readPositiveInteger(
        'ZONE_PUBLICATION_CANDIDATE_TIMEOUT_SECONDS',
        300,
      );

    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const [sourceState] = await manager.query(
        `SELECT "revision" FROM "zone_publication_source_state" WHERE "id" = 1 FOR UPDATE`,
      );
      const [state] = await manager.query(
        `SELECT * FROM "zone_publication_state" WHERE "id" = 1 FOR UPDATE`,
      );
      if (!state?.candidatePublicationId) {
        return { status: 'no_candidate' };
      }

      const [publication] = await manager.query(
        `SELECT * FROM "zone_publication" WHERE "id" = $1 FOR UPDATE`,
        [state.candidatePublicationId],
      );
      const rollback = publication?.status === 'retired';
      if (
        publication &&
        publication.status !== 'candidate' &&
        publication.status !== 'retired'
      ) {
        throw new Error(
          `Publication ${publication.id} has unexpected status ${publication.status}`,
        );
      }
      if (!publication) {
        await manager.query(
          `
            UPDATE "zone_publication_state"
            SET "candidatePublicationId" = NULL,
                "candidateRequestedAt" = NULL,
                "updatedAt" = now()
            WHERE "id" = 1
          `,
        );
        return {
          status: 'superseded',
          publicationId: state.candidatePublicationId,
        };
      }
      if (
        !rollback &&
        (String(publication.sourceRevision) !== String(sourceState.revision) ||
          Number(publication.materializationVersion) !==
            ZONE_PUBLICATION_MATERIALIZATION_VERSION)
      ) {
        if (publication.status === 'candidate') {
          await manager.query(
            `UPDATE "zone_publication" SET "status" = 'superseded' WHERE "id" = $1`,
            [publication.id],
          );
        }
        await manager.query(
          `
            UPDATE "zone_publication_state"
            SET "candidatePublicationId" = NULL,
                "candidateRequestedAt" = NULL,
                "updatedAt" = now()
            WHERE "id" = 1
          `,
        );
        return {
          status: 'superseded',
          publicationId: state.candidatePublicationId,
        };
      }

      const [instances] = await manager.query(
        `
          SELECT
            COUNT(*)::integer AS "liveInstances",
            COUNT(*) FILTER (
              WHERE "candidatePublicationId" = $1
                AND "lastError" IS NULL
                AND "zoneCount" = $3
                AND "communeLinkCount" = $4
                AND (
                  $5::varchar IS NULL
                  OR "contentFingerprint" = $5
                )
            )::integer AS "readyInstances"
          FROM "zone_publication_instance"
          WHERE "heartbeatAt" >= now() - ($2 * interval '1 second')
        `,
        [
          publication.id,
          leaseSeconds,
          publication.zoneCount,
          publication.communeLinkCount,
          publication.contentFingerprint,
        ],
      );
      const liveInstances = Number(instances.liveInstances);
      const readyInstances = Number(instances.readyInstances);
      if (
        liveInstances < minimumReadyInstances ||
        readyInstances !== liveInstances
      ) {
        if (
          readyInstances < liveInstances &&
          this.isCandidateExpired(
            publication,
            candidateTimeoutSeconds,
            state.candidateRequestedAt,
          )
        ) {
          const failureReason =
            `Candidate preload timed out after ${candidateTimeoutSeconds}s: ` +
            `${readyInstances}/${liveInstances} live instances ready`;
          if (!rollback) {
            const failed = unwrapTypeOrmDmlReturningRows<{ id: string }>(
              await manager.query(
                `
                  UPDATE "zone_publication"
                  SET "status" = 'failed',
                      "failedAt" = now(),
                      "validationError" = $2
                  WHERE "id" = $1 AND "status" = 'candidate'
                  RETURNING "id"
                `,
                [publication.id, failureReason],
              ),
            );
            if (failed.length !== 1) {
              throw new Error(
                `Unable to expire zone publication ${publication.id}`,
              );
            }
          }
          await manager.query(
            `
              UPDATE "zone_publication_state"
              SET "candidatePublicationId" = NULL,
                  "candidateRequestedAt" = NULL,
                  "updatedAt" = now()
              WHERE "id" = 1 AND "candidatePublicationId" = $1
            `,
            [publication.id],
          );
          return {
            status: rollback ? 'rollback_cancelled' : 'failed',
            publicationId: publication.id,
            liveInstances,
            readyInstances,
            ...(rollback ? { rollback: true } : {}),
          };
        }
        return {
          status: 'not_ready',
          publicationId: publication.id,
          liveInstances,
          readyInstances,
          ...(rollback ? { rollback: true } : {}),
        };
      }

      const [promotionLock] = await manager.query(
        'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
        [ZONE_PUBLICATION_STABLE_PROMOTION_LOCK],
      );
      if (promotionLock?.locked !== true) {
        return {
          status: 'busy',
          publicationId: publication.id,
          liveInstances,
          readyInstances,
          ...(rollback ? { rollback: true } : {}),
        };
      }

      if (
        state.activePublicationId &&
        state.activePublicationId !== publication.id
      ) {
        await manager.query(
          `UPDATE "zone_publication" SET "status" = 'retired' WHERE "id" = $1 AND "status" = 'active'`,
          [state.activePublicationId],
        );
      }
      const activated = unwrapTypeOrmDmlReturningRows<{ id: string }>(
        await manager.query(
          `
            UPDATE "zone_publication"
            SET "status" = 'active',
                "activatedAt" = now(),
                "legacyPromotedAt" = CASE WHEN $2 THEN NULL ELSE "legacyPromotedAt" END,
                "dataGouvPromotedAt" = CASE WHEN $2 THEN NULL ELSE "dataGouvPromotedAt" END,
                "promotionLastAttemptAt" = CASE WHEN $2 THEN NULL ELSE "promotionLastAttemptAt" END,
                "promotionError" = CASE WHEN $2 THEN NULL ELSE "promotionError" END
            WHERE "id" = $1
              AND "status" = CASE WHEN $2 THEN 'retired' ELSE 'candidate' END
            RETURNING "id"
          `,
          [publication.id, rollback],
        ),
      );
      if (activated.length !== 1) {
        throw new Error(`Unable to activate publication ${publication.id}`);
      }
      await manager.query(
        `
          UPDATE "zone_publication_state"
          SET "activePublicationId" = $1,
              "candidatePublicationId" = NULL,
              "candidateRequestedAt" = NULL,
              "automaticPublishingPaused" = CASE
                WHEN $2 THEN true
                ELSE "automaticPublishingPaused"
              END,
              "automaticPublishingPausedAt" = CASE
                WHEN $2 THEN COALESCE("automaticPublishingPausedAt", now())
                ELSE "automaticPublishingPausedAt"
              END,
              "updatedAt" = now()
          WHERE "id" = 1
        `,
        [publication.id, rollback],
      );
      return {
        status: 'activated',
        publicationId: publication.id,
        liveInstances,
        readyInstances,
        ...(rollback ? { rollback: true } : {}),
      };
    });
  }

  async purgeExpiredPublications(input?: {
    retainedRetiredCount?: number;
    retentionHours?: number;
  }): Promise<string[]> {
    const retainedRetiredCount =
      input?.retainedRetiredCount ??
      this.readPositiveInteger('ZONE_PUBLICATION_RETAIN_RETIRED', 4);
    const retentionHours =
      input?.retentionHours ??
      this.readPositiveInteger('ZONE_PUBLICATION_RETENTION_HOURS', 48);
    const deleted = unwrapTypeOrmDmlReturningRows<{ id: string }>(
      await this.dataSource.query(
        `
        WITH protected_retired AS MATERIALIZED (
          SELECT publication."id"
          FROM "zone_publication" publication
          WHERE publication."status" = 'retired'
          ORDER BY
            publication."activatedAt" DESC NULLS LAST,
            publication."createdAt" DESC
          LIMIT $1
        ), eligible AS MATERIALIZED (
          SELECT publication."id"
          FROM "zone_publication" publication
          CROSS JOIN "zone_publication_state" state
          WHERE state."id" = 1
            AND publication."status" IN ('retired', 'superseded', 'failed')
            AND publication."id" IS DISTINCT FROM state."activePublicationId"
            AND publication."id" IS DISTINCT FROM state."candidatePublicationId"
            AND COALESCE(publication."activatedAt", publication."createdAt")
                < now() - ($2 * interval '1 hour')
            AND (
              publication."status" <> 'retired'
              OR publication."id" NOT IN (SELECT "id" FROM protected_retired)
            )
        )
        DELETE FROM "zone_publication" publication
        USING eligible
        WHERE publication."id" = eligible."id"
        RETURNING publication."id"
        `,
        [retainedRetiredCount, retentionHours],
      ),
    );
    return deleted.map((row) => String(row.id));
  }

  async expireStalePublications(
    orphanTimeoutSeconds = this.readPositiveInteger(
      'ZONE_PUBLICATION_ORPHAN_TIMEOUT_SECONDS',
      75 * 60,
    ),
  ): Promise<string[]> {
    const failedBuilding = unwrapTypeOrmDmlReturningRows<{ id: string }>(
      await this.dataSource.query(
        `
        UPDATE "zone_publication" publication
        SET "status" = 'failed',
            "failedAt" = now(),
            "validationError" = 'Publication build was abandoned before validation'
        FROM "zone_publication_state" state
        WHERE state."id" = 1
          AND publication."status" = 'building'
          AND publication."createdAt" < now() - ($1 * interval '1 second')
          AND publication."id" IS DISTINCT FROM state."activePublicationId"
          AND publication."id" IS DISTINCT FROM state."candidatePublicationId"
        RETURNING publication."id"
        `,
        [orphanTimeoutSeconds],
      ),
    );
    const supersededValidated = unwrapTypeOrmDmlReturningRows<{ id: string }>(
      await this.dataSource.query(
        `
        UPDATE "zone_publication" publication
        SET "status" = 'superseded'
        FROM "zone_publication_state" state
        WHERE state."id" = 1
          AND publication."status" = 'validated'
          AND publication."createdAt" < now() - ($1 * interval '1 second')
          AND publication."id" IS DISTINCT FROM state."activePublicationId"
          AND publication."id" IS DISTINCT FROM state."candidatePublicationId"
        RETURNING publication."id"
        `,
        [orphanTimeoutSeconds],
      ),
    );
    return [...failedBuilding, ...supersededValidated].map((row) =>
      String(row.id),
    );
  }

  async purgeExpiredInstanceHeartbeats(
    retentionHours = this.readPositiveInteger(
      'ZONE_PUBLICATION_INSTANCE_RETENTION_HOURS',
      24,
    ),
  ): Promise<string[]> {
    const deleted = unwrapTypeOrmDmlReturningRows<{ instanceId: string }>(
      await this.dataSource.query(
        `
        DELETE FROM "zone_publication_instance"
        WHERE "heartbeatAt" < now() - ($1 * interval '1 hour')
        RETURNING "instanceId"
        `,
        [retentionHours],
      ),
    );
    return deleted.map((row) => String(row.instanceId));
  }

  @Interval(PUBLICATION_ACTIVATION_INTERVAL_MS)
  async activateCandidateOnSchedule(): Promise<void> {
    if (
      !shouldRunWebScheduledJobs() ||
      !isZonePublicationEnabled() ||
      this.activationInProgress
    ) {
      return;
    }
    this.activationInProgress = true;
    try {
      const result = await this.activateWhenReady();
      if (result.status === 'activated') {
        this.logger.log(`Activated zone publication ${result.publicationId}`);
      } else if (result.status === 'failed') {
        this.logger.error(
          `Expired unreadable zone publication ${result.publicationId}`,
          '',
        );
      } else if (result.status === 'superseded') {
        this.logger.log(
          `Discarded stale zone publication ${result.publicationId}`,
        );
      }
    } catch (error) {
      this.logger.error('ZONE PUBLICATION ACTIVATION ERROR', error);
    } finally {
      this.activationInProgress = false;
    }
  }

  @Interval(PUBLICATION_RECOVERY_INTERVAL_MS)
  async recoverStalePublicationsOnSchedule(): Promise<void> {
    if (!shouldRunWebScheduledJobs() || this.recoveryInProgress) {
      return;
    }
    this.recoveryInProgress = true;
    try {
      const recoveredIds = await this.expireStalePublications();
      if (recoveredIds.length > 0) {
        this.logger.error(
          `Expired ${recoveredIds.length} abandoned zone publications`,
          '',
        );
      }
    } catch (error) {
      this.logger.error('ZONE PUBLICATION RECOVERY ERROR', error);
    } finally {
      this.recoveryInProgress = false;
    }
  }

  @Interval(PUBLICATION_RETENTION_INTERVAL_MS)
  async purgePublicationsOnSchedule(): Promise<void> {
    if (!shouldRunWebScheduledJobs() || this.retentionInProgress) {
      return;
    }
    this.retentionInProgress = true;
    try {
      const [deletedIds, deletedInstanceIds] = await Promise.all([
        this.purgeExpiredPublications(),
        this.purgeExpiredInstanceHeartbeats(),
      ]);
      if (deletedIds.length > 0) {
        this.logger.log(
          `Purged ${deletedIds.length} expired zone publications`,
        );
      }
      if (deletedInstanceIds.length > 0) {
        this.logger.log(
          `Purged ${deletedInstanceIds.length} expired zone publication heartbeats`,
        );
      }
    } catch (error) {
      this.logger.error('ZONE PUBLICATION RETENTION ERROR', error);
    } finally {
      this.retentionInProgress = false;
    }
  }

  private assertArtifacts(options: ZonePublicationArtifacts): void {
    const values = [
      options.geojsonUrl,
      options.geojsonChecksum,
      options.pmtilesUrl,
      options.pmtilesChecksum,
    ];
    if (values.some((value) => !value?.trim())) {
      throw new Error(
        'Immutable GeoJSON and PMTiles artifacts are required for publication',
      );
    }
    if (
      options.geojsonChecksum.length !== 64 ||
      options.pmtilesChecksum.length !== 64 ||
      !/^[0-9a-f]{64}$/i.test(options.geojsonChecksum) ||
      !/^[0-9a-f]{64}$/i.test(options.pmtilesChecksum)
    ) {
      throw new Error('Zone publication checksums must be SHA-256 values');
    }
  }

  private async verifyPublicArtifacts(
    options: BuildZonePublicationOptions,
  ): Promise<void> {
    const timeoutMs = this.readPositiveInteger(
      'ZONE_PUBLICATION_ARTIFACT_TIMEOUT_MS',
      60_000,
    );
    await Promise.all([
      this.verifyPublicArtifact(
        options.geojsonUrl,
        'GeoJSON',
        timeoutMs,
        false,
        options.geojsonChecksum,
        options.artifactZoneCount,
      ),
      this.verifyPublicArtifact(
        options.pmtilesUrl,
        'PMTiles',
        timeoutMs,
        true,
        options.pmtilesChecksum,
        options.artifactZoneCount,
      ),
    ]);
  }

  private async verifyPublicArtifact(
    url: string,
    label: string,
    timeoutMs: number,
    expectPmtilesHeader: boolean,
    expectedChecksum: string,
    expectedFeatureCount: number,
  ): Promise<void> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`${label} publication artifact URL is invalid`);
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error(`${label} publication artifact URL must use HTTP(S)`);
    }

    const response = await fetch(parsedUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200 && response.status !== 206) {
      throw new Error(
        `${label} publication artifact returned HTTP ${response.status}`,
      );
    }

    const checksum = createHash('sha256');
    let firstBytes = Buffer.alloc(0);
    let totalBytes = 0;
    const geojsonChunks: Buffer[] = [];
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          if (chunk.value.byteLength > 0) {
            const content = Buffer.from(chunk.value);
            checksum.update(content);
            if (!expectPmtilesHeader) {
              geojsonChunks.push(content);
            }
            if (firstBytes.length < 127) {
              firstBytes = Buffer.concat([
                firstBytes,
                content.subarray(0, 127 - firstBytes.length),
              ]);
            }
            totalBytes += chunk.value.byteLength;
          }
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      }
    } else {
      const content = Buffer.from(await response.arrayBuffer());
      checksum.update(content);
      firstBytes = content.subarray(0, 127);
      totalBytes = content.length;
      if (!expectPmtilesHeader) {
        geojsonChunks.push(content);
      }
    }
    if (totalBytes === 0) {
      throw new Error(`${label} publication artifact is empty`);
    }
    const actualChecksum = checksum.digest('hex');
    if (actualChecksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
      throw new Error(`${label} publication artifact checksum is invalid`);
    }
    if (expectPmtilesHeader) {
      this.assertPmtilesHeader(
        firstBytes,
        totalBytes,
        label,
        expectedFeatureCount > 0,
      );
    } else {
      this.assertGeojsonArtifact(
        Buffer.concat(geojsonChunks),
        expectedFeatureCount,
        label,
      );
    }
  }

  private assertGeojsonArtifact(
    content: Buffer,
    expectedFeatureCount: number,
    label: string,
  ): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.toString('utf8'));
    } catch {
      throw new Error(`${label} publication artifact is not valid JSON`);
    }
    const artifact = parsed as {
      type?: unknown;
      features?: unknown;
    };
    if (
      !artifact ||
      artifact.type !== 'FeatureCollection' ||
      !Array.isArray(artifact.features)
    ) {
      throw new Error(
        `${label} publication artifact is not a valid FeatureCollection`,
      );
    }
    if (artifact.features.length !== expectedFeatureCount) {
      throw new Error(
        `${label} publication artifact contains ${artifact.features.length} features; expected ${expectedFeatureCount}`,
      );
    }
    const invalidFeature = artifact.features.some((value) => {
      const feature = value as {
        type?: unknown;
        geometry?: { type?: unknown; coordinates?: unknown } | null;
        properties?: unknown;
      };
      return (
        !feature ||
        feature.type !== 'Feature' ||
        !feature.geometry ||
        typeof feature.geometry.type !== 'string' ||
        feature.geometry.coordinates === undefined ||
        !feature.properties ||
        typeof feature.properties !== 'object'
      );
    });
    if (invalidFeature) {
      throw new Error(
        `${label} publication artifact contains an invalid feature`,
      );
    }
  }

  private assertPmtilesHeader(
    header: Buffer,
    totalBytes: number,
    label: string,
    expectTileContent: boolean,
  ): void {
    if (
      header.length < 127 ||
      header.subarray(0, 7).toString('ascii') !== 'PMTiles' ||
      header.readUInt8(7) !== 3
    ) {
      throw new Error(`${label} publication artifact header is invalid`);
    }

    const fileSize = BigInt(totalBytes);
    const sections = [
      [header.readBigUInt64LE(8), header.readBigUInt64LE(16)],
      [header.readBigUInt64LE(24), header.readBigUInt64LE(32)],
      [header.readBigUInt64LE(40), header.readBigUInt64LE(48)],
      [header.readBigUInt64LE(56), header.readBigUInt64LE(64)],
    ];
    const invalidSection = sections.some(
      ([offset, length]) =>
        offset < 127n || offset > fileSize || length > fileSize - offset,
    );
    const minZoom = header.readUInt8(100);
    const maxZoom = header.readUInt8(101);
    if (invalidSection || header.readUInt8(99) !== 1 || minZoom > maxZoom) {
      throw new Error(`${label} publication artifact header is invalid`);
    }
    if (
      expectTileContent &&
      (header.readBigUInt64LE(16) === 0n ||
        header.readBigUInt64LE(64) === 0n ||
        header.readBigUInt64LE(72) === 0n ||
        header.readBigUInt64LE(80) === 0n ||
        header.readBigUInt64LE(88) === 0n)
    ) {
      throw new Error(`${label} publication artifact contains no tile data`);
    }
  }

  private async assertCurrentSourceRevision(
    manager: EntityManager,
    expectedRevision: string,
  ): Promise<void> {
    const [state] = await manager.query(
      `SELECT "revision" FROM "zone_publication_source_state" WHERE "id" = 1`,
    );
    if (!state || String(state.revision) !== String(expectedRevision)) {
      throw new Error(
        `Zone source revision changed from ${expectedRevision} to ${state?.revision ?? 'missing'}`,
      );
    }
  }

  private async insertBuildingPublication(
    manager: EntityManager,
    publicationId: string,
    options: BuildZonePublicationOptions,
  ): Promise<void> {
    await manager.query(
      `
        INSERT INTO "zone_publication" (
          "id", "sourceRevision", "materializationVersion", "status", "sourceComputedAt",
          "geojsonUrl", "geojsonChecksum", "pmtilesUrl", "pmtilesChecksum"
        ) VALUES ($1, $2, $3, 'building', $4, $5, $6, $7, $8)
      `,
      [
        publicationId,
        options.sourceRevision,
        ZONE_PUBLICATION_MATERIALIZATION_VERSION,
        options.sourceComputedAt,
        options.geojsonUrl,
        options.geojsonChecksum,
        options.pmtilesUrl,
        options.pmtilesChecksum,
      ],
    );
  }

  private async loadSourceZones(
    manager: EntityManager,
  ): Promise<ZoneSourceRow[]> {
    return manager.query(`
      SELECT
        z."id",
        z."idSandre",
        z."code",
        z."nom",
        z."type",
        z."ressourceInfluencee",
        z."niveauGravite",
        z."departementId" AS "departmentId",
        d."code" AS "departmentCode",
        public_department."code" AS "publicDepartmentCode",
        CASE WHEN ar."id" IS NULL THEN NULL ELSE r."id" END AS "restrictionId",
        ar."id" AS "arreteId",
        ar."dateDebut" AS "dateDebutValidite",
        ar."dateFin" AS "dateFinValidite",
        ar_file."url" AS "cheminFichier",
        ac_file."url" AS "cheminFichierArreteCadre"
      FROM "zone_alerte_computed" z
      INNER JOIN "departement" d ON d."id" = z."departementId"
      LEFT JOIN "restriction" r ON r."id" = z."restrictionId"
      LEFT JOIN "arrete_restriction" ar
        ON ar."id" = r."arreteRestrictionId" AND ar."statut" = 'publie'
      LEFT JOIN "departement" public_department
        ON public_department."id" = ar."departementId"
      LEFT JOIN "fichier" ar_file ON ar_file."id" = ar."fichierId"
      LEFT JOIN "arrete_cadre" ac ON ac."id" = r."arreteCadreId"
      LEFT JOIN "fichier" ac_file ON ac_file."id" = ac."fichierId"
      ORDER BY z."id"
    `);
  }

  private async loadSourceUsages(
    manager: EntityManager,
    zones: ZoneSourceRow[],
  ): Promise<ZoneUsageRow[]> {
    const restrictionIds = [
      ...new Set(
        zones
          .map((zone) => zone.restrictionId)
          .filter((id): id is number => id !== null),
      ),
    ];
    if (restrictionIds.length === 0) {
      return [];
    }
    return manager.query(
      `
        SELECT
          u."id",
          u."restrictionId",
          u."nom",
          t."nom" AS "thematique",
          u."concerneParticulier",
          u."concerneEntreprise",
          u."concerneCollectivite",
          u."concerneExploitation",
          u."concerneEso",
          u."concerneEsu",
          u."concerneAep",
          u."descriptionVigilance",
          u."descriptionAlerte",
          u."descriptionAlerteRenforcee",
          u."descriptionCrise"
        FROM "usage" u
        LEFT JOIN "thematique" t ON t."id" = u."thematiqueId"
        WHERE u."restrictionId" = ANY($1::integer[])
        ORDER BY u."id"
      `,
      [restrictionIds],
    );
  }

  private async insertSnapshotZones(
    manager: EntityManager,
    publicationId: string,
    rows: Array<{
      sourceZoneId: number;
      departmentId: number;
      departmentCode: string;
      type: string;
      publicPayload: Record<string, unknown>;
    }>,
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const inserted = await manager.query(
      `
        INSERT INTO "zone_publication_zone" (
          "publicationId", "sourceZoneId", "departmentId",
          "departmentCode", "type", "geom", "publicPayload"
        )
        SELECT
          $1,
          input."sourceZoneId",
          input."departmentId",
          input."departmentCode",
          input."type",
          source."geom",
          input."publicPayload"
        FROM jsonb_to_recordset($2::jsonb) AS input(
          "sourceZoneId" integer,
          "departmentId" integer,
          "departmentCode" character varying,
          "type" character varying,
          "publicPayload" jsonb
        )
        INNER JOIN "zone_alerte_computed" source
          ON source."id" = input."sourceZoneId"
        RETURNING "id"
      `,
      [publicationId, JSON.stringify(rows)],
    );
    if (inserted.length !== rows.length) {
      throw new Error(
        `Expected ${rows.length} publication zones, inserted ${inserted.length}`,
      );
    }
  }

  private async insertComputedCommuneLinks(
    manager: EntityManager,
    publicationId: string,
  ): Promise<void> {
    await manager.query(
      `
        INSERT INTO "zone_publication_commune" (
          "publicationZoneId", "communeId", "publicationId", "communeCode"
        )
        SELECT pz."id", c."id", pz."publicationId", c."code"
        FROM "zone_publication_zone" pz
        INNER JOIN "commune" c
          ON c."departementId" = pz."departmentId"
         AND ST_Intersects(pz."geom", c."geom")
         AND ST_Area(ST_Intersection(pz."geom", c."geom"))
             / NULLIF(ST_Area(c."geom"), 0) > 0.001
        WHERE pz."publicationId" = $1
          AND ST_GeometryType(pz."geom") IN ('ST_Polygon', 'ST_MultiPolygon')
          AND ST_IsValid(ST_Transform(pz."geom", 4326))
          AND ST_IsValid(ST_Transform(c."geom", 4326))
      `,
      [publicationId],
    );
  }

  private async insertAggregate(
    manager: EntityManager,
    publicationId: string,
    aggregate: ZonePublicationAggregatePayload,
  ): Promise<void> {
    const inserted = unwrapTypeOrmDmlReturningRows<{ publicationId: string }>(
      await manager.query(
        `
          INSERT INTO "zone_publication_aggregate" ("publicationId", "payload")
          VALUES ($1, $2)
          RETURNING "publicationId"
        `,
        [publicationId, aggregate],
      ),
    );
    if (inserted.length !== 1) {
      throw new Error(
        `Unable to materialize aggregate for publication ${publicationId}`,
      );
    }
  }

  private async computeMaterializationFingerprint(
    manager: EntityManager,
    publicationId: string,
    aggregate: ZonePublicationAggregatePayload,
  ): Promise<string> {
    const rows = await manager.query(
      `
        SELECT
          zone."sourceZoneId" AS "sourceZoneId",
          zone."departmentCode" AS "departmentCode",
          zone."type" AS "type",
          ST_AsGeoJSON(ST_Transform(zone."geom", 4326)) AS "geometry",
          zone."publicPayload" AS "publicPayload",
          COALESCE(
            array_agg(commune."communeCode" ORDER BY commune."communeCode")
              FILTER (WHERE commune."communeCode" IS NOT NULL),
            ARRAY[]::varchar[]
          ) AS "communeCodes"
        FROM "zone_publication_zone" zone
        LEFT JOIN "zone_publication_commune" commune
          ON commune."publicationId" = zone."publicationId"
         AND commune."publicationZoneId" = zone."id"
        WHERE zone."publicationId" = $1
        GROUP BY zone."id"
        ORDER BY zone."sourceZoneId"
      `,
      [publicationId],
    );
    return computeZonePublicationFingerprint({
      zones: rows.map(
        (row): ZonePublicationMaterializedZone => ({
          sourceZoneId: row.sourceZoneId,
          departmentCode: row.departmentCode,
          type: row.type,
          geometry: row.geometry || '',
          publicPayload: row.publicPayload || {},
          communeCodes: row.communeCodes || [],
        }),
      ),
      aggregate,
    });
  }

  private async validateSnapshot(
    manager: EntityManager,
    publicationId: string,
  ): Promise<ZonePublicationSnapshotCounts> {
    const [invalid] = await manager.query(
      `
        SELECT COUNT(*)::integer AS "count"
        FROM "zone_publication_zone"
        WHERE "publicationId" = $1
          AND (
            "geom" IS NULL
            OR ST_GeometryType("geom") NOT IN ('ST_Polygon', 'ST_MultiPolygon')
            OR NOT ST_IsValid(ST_Transform("geom", 4326))
            OR jsonb_typeof("publicPayload") <> 'object'
            OR NOT ("publicPayload" ?& ARRAY[
              'id', 'nom', 'type', 'ressourceInfluencee',
              'niveauGravite', 'arrete'
            ])
            OR ("publicPayload" ->> 'id')::integer <> "sourceZoneId"
            OR "publicPayload" ->> 'type' <> "type"
            OR NULLIF(btrim("publicPayload" ->> 'nom'), '') IS NULL
            OR jsonb_typeof("publicPayload" -> 'ressourceInfluencee') <> 'boolean'
            OR jsonb_typeof("publicPayload" -> 'arrete') <> 'object'
            OR (
              "publicPayload" ->> 'niveauGravite' IS NOT NULL
              AND "publicPayload" ->> 'niveauGravite' NOT IN (
                'vigilance', 'alerte', 'alerte_renforcee', 'crise'
              )
            )
            OR (
              "publicPayload" ? 'departement'
              AND (
                NULLIF(btrim("publicPayload" ->> 'departement'), '') IS NULL
                OR NOT ("publicPayload" ? 'usages')
                OR jsonb_typeof("publicPayload" -> 'usages') <> 'array'
                OR NOT (("publicPayload" -> 'arrete') ? 'id')
              )
            )
            OR (
              "publicPayload" ? 'usages'
              AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements("publicPayload" -> 'usages') usage
                WHERE jsonb_typeof(usage) <> 'object'
                  OR NOT (usage ?& ARRAY['id', 'nom', 'description'])
                  OR NULLIF(btrim(usage ->> 'nom'), '') IS NULL
              )
            )
          )
      `,
      [publicationId],
    );
    if (Number(invalid.count) > 0) {
      throw new Error(
        `Zone publication contains ${invalid.count} invalid zones or payloads`,
      );
    }

    const [linkDiff] = await manager.query(
      `
        WITH expected AS MATERIALIZED (
          SELECT pz."id" AS "publicationZoneId", c."id" AS "communeId"
          FROM "zone_publication_zone" pz
          INNER JOIN "commune" c
            ON c."departementId" = pz."departmentId"
           AND ST_Intersects(pz."geom", c."geom")
           AND ST_Area(ST_Intersection(pz."geom", c."geom"))
               / NULLIF(ST_Area(c."geom"), 0) > 0.001
          WHERE pz."publicationId" = $1
            AND ST_GeometryType(pz."geom") IN ('ST_Polygon', 'ST_MultiPolygon')
            AND ST_IsValid(ST_Transform(pz."geom", 4326))
            AND ST_IsValid(ST_Transform(c."geom", 4326))
        ), actual AS MATERIALIZED (
          SELECT "publicationZoneId", "communeId"
          FROM "zone_publication_commune"
          WHERE "publicationId" = $1
        )
        SELECT
          (
            SELECT COUNT(*)::integer FROM (
              SELECT * FROM expected
              EXCEPT
              SELECT * FROM actual
            ) missing_rows
          ) AS "missingCount",
          (
            SELECT COUNT(*)::integer FROM (
              SELECT * FROM actual
              EXCEPT
              SELECT * FROM expected
            ) extra_rows
          ) AS "extraCount"
      `,
      [publicationId],
    );
    if (Number(linkDiff.missingCount) > 0 || Number(linkDiff.extraCount) > 0) {
      throw new Error(
        `Zone publication commune links differ from PostGIS intersections: ${linkDiff.missingCount} missing, ${linkDiff.extraCount} extra`,
      );
    }

    const [counts] = await manager.query(
      `
        SELECT
          (SELECT COUNT(*)::integer FROM "zone_publication_zone" WHERE "publicationId" = $1) AS "zoneCount",
          (SELECT COUNT(*)::integer FROM "zone_publication_commune" WHERE "publicationId" = $1) AS "communeLinkCount"
      `,
      [publicationId],
    );
    return {
      zoneCount: Number(counts.zoneCount),
      communeLinkCount: Number(counts.communeLinkCount),
    };
  }

  private async assertPlausibleSnapshot(
    manager: EntityManager,
    counts: { zoneCount: number; communeLinkCount: number },
  ): Promise<void> {
    if (counts.zoneCount < 0 || counts.communeLinkCount < 0) {
      throw new Error('Zone publication counts cannot be negative');
    }
    if (counts.zoneCount === 0) {
      if (counts.communeLinkCount !== 0) {
        throw new Error(
          'An empty zone publication cannot contain commune associations',
        );
      }
      const [sourceState] = await manager.query(`
        SELECT EXISTS (
          SELECT 1
          FROM "arrete_restriction"
          WHERE "statut" = 'publie'
        ) AS "hasPublishedArrete"
      `);
      if (sourceState?.hasPublishedArrete === true) {
        throw new Error(
          'An empty zone publication is forbidden while published restrictions exist',
        );
      }
      return;
    }
    if (counts.communeLinkCount === 0) {
      throw new Error(
        'A national zone publication must contain commune associations',
      );
    }

    const [active] = await manager.query(`
      SELECT publication."zoneCount", publication."communeLinkCount"
      FROM "zone_publication_state" state
      INNER JOIN "zone_publication" publication
        ON publication."id" = state."activePublicationId"
       AND publication."status" = 'active'
      WHERE state."id" = 1
    `);
    if (!active) {
      return;
    }

    const activeZoneCount = Number(active.zoneCount);
    const activeCommuneLinkCount = Number(active.communeLinkCount);
    const minimumDensityPercent = this.readOptionalPercentage(
      'ZONE_PUBLICATION_MIN_LINK_DENSITY_PERCENT',
    );
    if (minimumDensityPercent !== null) {
      this.assertMinimumDensityRatio(
        counts,
        {
          zoneCount: activeZoneCount,
          communeLinkCount: activeCommuneLinkCount,
        },
        minimumDensityPercent,
      );
    }

    const minimumZonePercent = this.readOptionalPercentage(
      'ZONE_PUBLICATION_MIN_ZONE_COUNT_PERCENT',
    );
    if (minimumZonePercent !== null) {
      this.assertMinimumCountRatio(
        'zone',
        counts.zoneCount,
        activeZoneCount,
        minimumZonePercent,
      );
    }
    const minimumCommuneLinkPercent = this.readOptionalPercentage(
      'ZONE_PUBLICATION_MIN_COMMUNE_LINK_COUNT_PERCENT',
    );
    if (minimumCommuneLinkPercent !== null) {
      this.assertMinimumCountRatio(
        'commune link',
        counts.communeLinkCount,
        activeCommuneLinkCount,
        minimumCommuneLinkPercent,
      );
    }
  }

  private async recordFailedPublication(
    publicationId: string,
    options: BuildZonePublicationOptions,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await this.dataSource.query(
        `
          INSERT INTO "zone_publication" (
            "id", "sourceRevision", "materializationVersion", "status", "sourceComputedAt",
            "geojsonUrl", "geojsonChecksum", "pmtilesUrl", "pmtilesChecksum",
            "validationError", "failedAt"
          ) VALUES ($1, $2, $3, 'failed', $4, $5, $6, $7, $8, $9, now())
          ON CONFLICT ("id") DO UPDATE
          SET "status" = 'failed',
              "validationError" = EXCLUDED."validationError",
              "failedAt" = now()
          WHERE "zone_publication"."status" = 'building'
        `,
        [
          publicationId,
          options.sourceRevision,
          ZONE_PUBLICATION_MATERIALIZATION_VERSION,
          options.sourceComputedAt,
          options.geojsonUrl,
          options.geojsonChecksum,
          options.pmtilesUrl,
          options.pmtilesChecksum,
          message.slice(0, 10_000),
        ],
      );
    } catch (recordError) {
      this.logger.error(
        'UNABLE TO RECORD FAILED ZONE PUBLICATION',
        recordError,
      );
    }
  }

  private readPositiveInteger(name: string, fallback: number): number {
    const parsed = Number.parseInt(process.env[name] || '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private readOptionalPercentage(name: string): number | null {
    if (!process.env[name]?.trim()) {
      return null;
    }
    const parsed = Number.parseFloat(process.env[name]);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
      throw new Error(`${name} must be greater than 0 and at most 100`);
    }
    return parsed;
  }

  private assertMinimumDensityRatio(
    candidate: { zoneCount: number; communeLinkCount: number },
    active: { zoneCount: number; communeLinkCount: number },
    minimumPercent: number,
  ): void {
    if (active.zoneCount <= 0 || active.communeLinkCount <= 0) {
      return;
    }
    const activeDensity = active.communeLinkCount / active.zoneCount;
    const candidateDensity = candidate.communeLinkCount / candidate.zoneCount;
    const minimumDensity = (activeDensity * minimumPercent) / 100;
    if (candidateDensity < minimumDensity) {
      throw new Error(
        `Zone publication commune-link density dropped from ${activeDensity.toFixed(3)} to ${candidateDensity.toFixed(3)} per zone; minimum is ${minimumPercent}% (${minimumDensity.toFixed(3)})`,
      );
    }
  }

  private assertMinimumCountRatio(
    label: string,
    candidateCount: number,
    activeCount: number,
    minimumPercent: number,
  ): void {
    if (activeCount <= 0) {
      return;
    }
    const minimumCount = Math.ceil((activeCount * minimumPercent) / 100);
    if (candidateCount < minimumCount) {
      throw new Error(
        `Zone publication ${label} count dropped from ${activeCount} to ${candidateCount}; minimum is ${minimumPercent}% (${minimumCount})`,
      );
    }
  }

  private isCandidateExpired(
    publication: {
      candidateAt?: Date | string | null;
      validatedAt?: Date | string | null;
      createdAt?: Date | string | null;
    },
    timeoutSeconds: number,
    requestedAt?: Date | string | null,
  ): boolean {
    const startedAt = new Date(
      requestedAt ||
        publication.candidateAt ||
        publication.validatedAt ||
        publication.createdAt ||
        '',
    ).getTime();
    return (
      Number.isFinite(startedAt) &&
      Date.now() - startedAt >= timeoutSeconds * 1000
    );
  }
}
