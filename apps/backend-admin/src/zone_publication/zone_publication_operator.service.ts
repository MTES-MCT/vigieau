import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  isZonePublicationEnabled,
  ZONE_PUBLICATION_MATERIALIZATION_VERSION,
} from './zone_publication.config';
import type { ZonePublicationRollbackResult } from './zone_publication.service';
import { unwrapTypeOrmDmlReturningRows } from './typeorm-query-result';

@Injectable()
export class ZonePublicationOperatorService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async getOperationalState(): Promise<Record<string, unknown>> {
    const leaseSeconds = this.readPositiveInteger(
      'ZONE_PUBLICATION_INSTANCE_LEASE_SECONDS',
      30,
    );
    const minimumReadyInstances = this.readPositiveInteger(
      'ZONE_PUBLICATION_MIN_READY_INSTANCES',
      2,
    );
    const [state] = await this.dataSource.query(
      `
        SELECT
          source."revision" AS "sourceRevision",
          state."updatedAt" AS "stateUpdatedAt",
          state."candidateRequestedAt" AS "candidateRequestedAt",
          state."automaticPublishingPaused" AS "automaticPublishingPaused",
          state."automaticPublishingPausedAt" AS "automaticPublishingPausedAt",
          active."id" AS "activeId",
          active."revision" AS "activeRevision",
          active."sourceRevision" AS "activeSourceRevision",
          active."sourceComputedAt" AS "activeSourceComputedAt",
          active."contentFingerprint" AS "activeFingerprint",
          active."legacyPromotedAt" AS "legacyPromotedAt",
          active."dataGouvPromotedAt" AS "dataGouvPromotedAt",
          active."promotionError" AS "promotionError",
          candidate."id" AS "candidateId",
          candidate."status" AS "candidateStatus",
          candidate."sourceRevision" AS "candidateSourceRevision",
          candidate."sourceComputedAt" AS "candidateSourceComputedAt",
          candidate."contentFingerprint" AS "candidateFingerprint",
          candidate."validationReport" AS "candidateValidationReport",
          candidate."validationError" AS "candidateError",
          failed."id" AS "lastFailedId",
          failed."failedAt" AS "lastFailedAt",
          failed."validationError" AS "lastFailure",
          instances."liveInstances" AS "liveInstances",
          instances."activeReadyInstances" AS "activeReadyInstances",
          instances."candidateReadyInstances" AS "candidateReadyInstances",
          statistic_state."revision" AS "statisticRevision",
          statistic_state."currentPublishedDate"::text AS "statisticCurrentPublishedDate",
          statistic_state."historicPublishedThrough"::text AS "statisticHistoricPublishedThrough",
          statistic_state."historicDirtyFrom"::text AS "statisticHistoricDirtyFrom",
          statistic_state."historicDirtyThrough"::text AS "statisticHistoricDirtyThrough",
          statistic_snapshot."snapshotDate" AS "statisticSnapshotDate",
          statistic_snapshot."scope" AS "statisticSnapshotScope",
          statistic_snapshot."status" AS "statisticSnapshotStatus",
          statistic_snapshot."sourceRevision" AS "statisticSnapshotSourceRevision",
          statistic_snapshot."expectedCommuneCount" AS "statisticSnapshotExpectedCommuneCount",
          statistic_snapshot."processedCommuneCount" AS "statisticSnapshotProcessedCommuneCount",
          statistic_snapshot."startedAt" AS "statisticSnapshotStartedAt",
          statistic_snapshot."completedAt" AS "statisticSnapshotCompletedAt",
          statistic_snapshot."updatedAt" AS "statisticSnapshotUpdatedAt",
          incomplete_statistics."count" AS "incompleteStatisticSnapshotCount"
        FROM "zone_publication_source_state" source
        INNER JOIN "zone_publication_state" state ON state."id" = 1
        LEFT JOIN "statistic_publication_state" statistic_state
          ON statistic_state."id" = 1
        LEFT JOIN "zone_publication" active
          ON active."id" = state."activePublicationId"
        LEFT JOIN "zone_publication" candidate
          ON candidate."id" = state."candidatePublicationId"
        LEFT JOIN LATERAL (
          SELECT publication."id", publication."failedAt",
                 publication."validationError"
          FROM "zone_publication" publication
          WHERE publication."status" = 'failed'
          ORDER BY publication."failedAt" DESC NULLS LAST
          LIMIT 1
        ) failed ON true
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::integer AS "liveInstances",
            COUNT(*) FILTER (
              WHERE instance."activePublicationId" = active."id"
                AND (
                  active."contentFingerprint" IS NULL
                  OR instance."contentFingerprint" = active."contentFingerprint"
                )
            )::integer AS "activeReadyInstances",
            COUNT(*) FILTER (
              WHERE instance."candidatePublicationId" = candidate."id"
                AND instance."lastError" IS NULL
                AND instance."zoneCount" = candidate."zoneCount"
                AND instance."communeLinkCount" = candidate."communeLinkCount"
                AND (
                  candidate."contentFingerprint" IS NULL
                  OR instance."contentFingerprint" = candidate."contentFingerprint"
                )
            )::integer AS "candidateReadyInstances"
          FROM "zone_publication_instance" instance
          WHERE instance."heartbeatAt" >= now() - ($1 * interval '1 second')
        ) instances ON true
        LEFT JOIN LATERAL (
          SELECT
            snapshot."snapshotDate"::text AS "snapshotDate",
            snapshot."scope",
            snapshot."status",
            snapshot."sourceRevision",
            snapshot."expectedCommuneCount",
            snapshot."processedCommuneCount",
            snapshot."startedAt",
            snapshot."completedAt",
            snapshot."updatedAt"
          FROM "statistic_commune_snapshot" snapshot
          ORDER BY snapshot."updatedAt" DESC,
                   snapshot."snapshotDate" DESC,
                   snapshot."scope" ASC
          LIMIT 1
        ) statistic_snapshot ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::integer AS "count"
          FROM "statistic_commune_snapshot" snapshot
          WHERE snapshot."status" NOT IN ('ready', 'completed')
             OR snapshot."processedCommuneCount" <> snapshot."expectedCommuneCount"
        ) incomplete_statistics ON true
        WHERE source."id" = 1
      `,
      [leaseSeconds],
    );

    return {
      enabled: isZonePublicationEnabled(),
      minimumReadyInstances,
      sourceRevision: state ? String(state.sourceRevision) : null,
      stateUpdatedAt: state?.stateUpdatedAt || null,
      automaticPublishing: {
        paused: state?.automaticPublishingPaused === true,
        pausedAt: state?.automaticPublishingPausedAt || null,
      },
      statistics: {
        revision:
          state?.statisticRevision === null ||
          state?.statisticRevision === undefined
            ? null
            : String(state.statisticRevision),
        currentPublishedDate: state?.statisticCurrentPublishedDate || null,
        historicPublishedThrough:
          state?.statisticHistoricPublishedThrough || null,
        dirtyRange:
          state?.statisticHistoricDirtyFrom ||
          state?.statisticHistoricDirtyThrough
            ? {
                from: state?.statisticHistoricDirtyFrom || null,
                through: state?.statisticHistoricDirtyThrough || null,
              }
            : null,
        currentSnapshot: state?.statisticSnapshotDate
          ? {
              date: state.statisticSnapshotDate,
              scope: state.statisticSnapshotScope,
              status: state.statisticSnapshotStatus,
              sourceRevision:
                state.statisticSnapshotSourceRevision === null ||
                state.statisticSnapshotSourceRevision === undefined
                  ? null
                  : String(state.statisticSnapshotSourceRevision),
              progress: {
                expectedCommuneCount: Number(
                  state.statisticSnapshotExpectedCommuneCount || 0,
                ),
                processedCommuneCount: Number(
                  state.statisticSnapshotProcessedCommuneCount || 0,
                ),
              },
              startedAt: state.statisticSnapshotStartedAt,
              completedAt: state.statisticSnapshotCompletedAt || null,
              updatedAt: state.statisticSnapshotUpdatedAt,
            }
          : null,
        incompleteSnapshotCount: Number(
          state?.incompleteStatisticSnapshotCount || 0,
        ),
      },
      active: state?.activeId
        ? {
            id: state.activeId,
            revision: String(state.activeRevision),
            sourceRevision: String(state.activeSourceRevision),
            sourceComputedAt: state.activeSourceComputedAt,
            fingerprint: state.activeFingerprint,
            legacyPromotedAt: state.legacyPromotedAt,
            dataGouvPromotedAt: state.dataGouvPromotedAt,
            promotionError: state.promotionError,
          }
        : null,
      candidate: state?.candidateId
        ? {
            id: state.candidateId,
            mode: state.candidateStatus === 'retired' ? 'rollback' : 'publish',
            status: state.candidateStatus,
            requestedAt: state.candidateRequestedAt,
            sourceRevision: String(state.candidateSourceRevision),
            sourceComputedAt: state.candidateSourceComputedAt,
            fingerprint: state.candidateFingerprint,
            validationReport: state.candidateValidationReport,
            error: state.candidateError,
          }
        : null,
      quorum: {
        liveInstances: Number(state?.liveInstances || 0),
        activeReadyInstances: Number(state?.activeReadyInstances || 0),
        candidateReadyInstances: Number(state?.candidateReadyInstances || 0),
        minimumReadyInstances,
      },
      lastFailure: state?.lastFailedId
        ? {
            id: state.lastFailedId,
            at: state.lastFailedAt,
            error: state.lastFailure,
          }
        : null,
    };
  }

  async prepareRollback(input?: {
    publicationId?: string;
    apply?: boolean;
  }): Promise<ZonePublicationRollbackResult> {
    if (!isZonePublicationEnabled()) {
      return { status: 'disabled' };
    }
    if (input?.apply && !input.publicationId) {
      return {
        status: 'blocked',
        blockers: ['publicationId from a prior rollback dry-run is required'],
      };
    }
    const minimumReadyInstances = this.readPositiveInteger(
      'ZONE_PUBLICATION_MIN_READY_INSTANCES',
      2,
    );
    const leaseSeconds = this.readPositiveInteger(
      'ZONE_PUBLICATION_INSTANCE_LEASE_SECONDS',
      30,
    );

    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const [state] = await manager.query(`
        SELECT
          publication_state.*,
          source_state."revision" AS "currentSourceRevision",
          statistic_state."historicDirtyFrom"::text AS "historicDirtyFrom",
          statistic_state."historicDirtyThrough"::text AS "historicDirtyThrough"
        FROM "zone_publication_state" publication_state
        CROSS JOIN "zone_publication_source_state" source_state
        CROSS JOIN "statistic_publication_state" statistic_state
        WHERE publication_state."id" = 1
          AND source_state."id" = 1
          AND statistic_state."id" = 1
        ${
          input?.apply
            ? 'FOR UPDATE OF publication_state, source_state, statistic_state'
            : ''
        }
      `);
      if (!state?.activePublicationId) {
        return { status: 'no_active_publication' };
      }
      const [pendingCandidate] = state.candidatePublicationId
        ? await manager.query(
            `
              SELECT "id", "status"
              FROM "zone_publication"
              WHERE "id" = $1
              ${input?.apply ? 'FOR UPDATE' : ''}
            `,
            [state.candidatePublicationId],
          )
        : [];
      const [target] = await manager.query(
        `
          SELECT publication.*,
                 aggregate."publicationId" IS NOT NULL AS "hasAggregate",
                 EXISTS (
                   SELECT 1
                   FROM "statistic_commune_snapshot" certified_snapshot
                   WHERE certified_snapshot."snapshotDate" =
                       (publication."sourceComputedAt" AT TIME ZONE 'UTC')::date
                     AND certified_snapshot."scope" = 'national'
                     AND certified_snapshot."status" = 'completed'
                     AND certified_snapshot."sourceRevision" =
                       publication."sourceRevision"
                 ) AS "hasCertifiedStatisticSnapshot",
                 (
                   SELECT COUNT(*)::integer
                   FROM "statistic_commune_snapshot" incomplete_snapshot
                   WHERE incomplete_snapshot."scope" <> 'bootstrap'
                     AND incomplete_snapshot."snapshotDate" <=
                       (publication."sourceComputedAt" AT TIME ZONE 'UTC')::date
                     AND incomplete_snapshot."status" <> 'completed'
                 ) AS "incompleteStatisticSnapshotCount"
          FROM "zone_publication" publication
          LEFT JOIN "zone_publication_aggregate" aggregate
            ON aggregate."publicationId" = publication."id"
          WHERE publication."status" = 'retired'
            AND publication."id" IS DISTINCT FROM $1
            AND ($2::uuid IS NULL OR publication."id" = $2)
          ORDER BY publication."activatedAt" DESC NULLS LAST,
                   publication."createdAt" DESC
          LIMIT 1
          ${input?.apply ? 'FOR UPDATE OF publication' : ''}
        `,
        [state.activePublicationId, input?.publicationId || null],
      );
      if (!target) {
        return {
          status: 'no_target',
          activePublicationId: state.activePublicationId,
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
                AND "contentFingerprint" = $5
            )::integer AS "readyInstances"
          FROM "zone_publication_instance"
          WHERE "heartbeatAt" >= now() - ($2 * interval '1 second')
        `,
        [
          target.id,
          leaseSeconds,
          target.zoneCount,
          target.communeLinkCount,
          target.contentFingerprint,
        ],
      );
      const blockers: string[] = [];
      const pendingIsTarget = pendingCandidate?.id === target.id;
      const pendingIsReplaceable =
        Boolean(pendingCandidate) &&
        !pendingIsTarget &&
        pendingCandidate.status === 'candidate';
      if (pendingCandidate && !pendingIsTarget && !pendingIsReplaceable) {
        blockers.push(
          `candidate ${pendingCandidate.id} with status ${pendingCandidate.status} cannot be replaced`,
        );
      }
      if (!target.hasAggregate) {
        blockers.push('target has no versioned department aggregate');
      }
      if (
        String(target.sourceRevision) !== String(state.currentSourceRevision)
      ) {
        blockers.push(
          `target source revision ${target.sourceRevision} does not match current source revision ${state.currentSourceRevision}`,
        );
      }
      if (
        Number(target.materializationVersion) !==
        ZONE_PUBLICATION_MATERIALIZATION_VERSION
      ) {
        blockers.push(
          `target materialization version ${target.materializationVersion} does not match current version ${ZONE_PUBLICATION_MATERIALIZATION_VERSION}`,
        );
      }
      if (target.hasCertifiedStatisticSnapshot !== true) {
        blockers.push(
          'target has no certified national statistic snapshot for its source revision',
        );
      }
      if (Number(target.incompleteStatisticSnapshotCount || 0) > 0) {
        blockers.push(
          `${target.incompleteStatisticSnapshotCount} incomplete statistic snapshot(s) exist on or before the target date`,
        );
      }
      if (
        state.historicDirtyFrom !== null ||
        state.historicDirtyThrough !== null
      ) {
        blockers.push(
          `historic statistics are dirty from ${state.historicDirtyFrom || 'unknown'} through ${state.historicDirtyThrough || 'unknown'}`,
        );
      }
      if (!/^[0-9a-f]{64}$/.test(target.contentFingerprint || '')) {
        blockers.push('target has no valid materialization fingerprint');
      }
      if (
        !target.geojsonUrl ||
        !target.geojsonChecksum ||
        !target.pmtilesUrl ||
        !target.pmtilesChecksum
      ) {
        blockers.push('target has incomplete immutable artifacts');
      }

      const result: ZonePublicationRollbackResult = {
        status: input?.apply ? 'prepared' : 'dry_run',
        activePublicationId: state.activePublicationId,
        targetPublicationId: target.id,
        minimumReadyInstances,
        liveInstances: Number(instances?.liveInstances || 0),
        readyInstances: Number(instances?.readyInstances || 0),
        blockers,
        ...(pendingCandidate
          ? {
              pendingCandidate: {
                id: pendingCandidate.id,
                status: pendingCandidate.status,
                replaceable: pendingIsReplaceable,
              },
            }
          : {}),
      };
      if (blockers.length > 0) {
        return { ...result, status: 'blocked' };
      }
      if (!input?.apply) {
        return result;
      }
      if (pendingIsTarget) {
        await manager.query(`
          UPDATE "zone_publication_state"
          SET "automaticPublishingPaused" = true,
              "automaticPublishingPausedAt" = COALESCE(
                "automaticPublishingPausedAt",
                now()
              ),
              "updatedAt" = now()
          WHERE "id" = 1
        `);
        return { ...result, status: 'candidate_pending' };
      }

      let replacedCandidatePublicationId: string | undefined;
      if (pendingIsReplaceable) {
        const replaced = unwrapTypeOrmDmlReturningRows<{ id: string }>(
          await manager.query(
            `
              UPDATE "zone_publication"
              SET "status" = 'superseded'
              WHERE "id" = $1 AND "status" = 'candidate'
              RETURNING "id"
            `,
            [pendingCandidate.id],
          ),
        );
        if (replaced.length !== 1) {
          return {
            ...result,
            status: 'blocked',
            blockers: ['pending candidate changed during rollback'],
          };
        }
        replacedCandidatePublicationId = pendingCandidate.id;
      }

      await manager.query(
        `
          UPDATE "zone_publication_state"
          SET "candidatePublicationId" = $1,
              "candidateRequestedAt" = now(),
              "automaticPublishingPaused" = true,
              "automaticPublishingPausedAt" = COALESCE(
                "automaticPublishingPausedAt",
                now()
              ),
              "updatedAt" = now()
          WHERE "id" = 1
        `,
        [target.id],
      );
      return {
        ...result,
        ...(replacedCandidatePublicationId
          ? { replacedCandidatePublicationId }
          : {}),
      };
    });
  }

  async resumeAutomaticPublishing(): Promise<{
    status: 'not_paused' | 'resumed';
    cancelledRollbackPublicationId?: string;
  }> {
    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const [state] = await manager.query(`
        SELECT state.*,
               candidate."status" AS "candidateStatus"
        FROM "zone_publication_state" state
        LEFT JOIN "zone_publication" candidate
          ON candidate."id" = state."candidatePublicationId"
        WHERE state."id" = 1
        FOR UPDATE OF state
      `);
      if (state?.automaticPublishingPaused !== true) {
        return { status: 'not_paused' };
      }

      const cancelledRollbackPublicationId =
        state.candidateStatus === 'retired'
          ? state.candidatePublicationId
          : undefined;
      await manager.query(
        `
          UPDATE "zone_publication_state"
          SET "candidatePublicationId" = CASE WHEN $1 THEN NULL ELSE "candidatePublicationId" END,
              "candidateRequestedAt" = CASE WHEN $1 THEN NULL ELSE "candidateRequestedAt" END,
              "automaticPublishingPaused" = false,
              "automaticPublishingPausedAt" = NULL,
              "updatedAt" = now()
          WHERE "id" = 1
        `,
        [Boolean(cancelledRollbackPublicationId)],
      );
      return {
        status: 'resumed',
        ...(cancelledRollbackPublicationId
          ? { cancelledRollbackPublicationId }
          : {}),
      };
    });
  }

  private readPositiveInteger(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
}
