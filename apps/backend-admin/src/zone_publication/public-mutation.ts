import { EntityManager } from 'typeorm';
import { unwrapTypeOrmDmlReturningRows } from './typeorm-query-result';

export type PublicZoneType = 'AEP' | 'SOU' | 'SUP';
export type CertifiedZoneTypeAvailability = 'available' | 'confirmed_none';

export class ZoneAvailabilityCertificationSupersededError extends Error {}

export async function enqueueCurrentZoneRecomputeTarget(
  manager: EntityManager,
  departementIds: number[],
  targetPublicRevision: string,
  reason: string,
  scheduledFor?: string,
): Promise<void> {
  const ids = [...new Set(departementIds)].sort((left, right) => left - right);
  if (ids.length === 0) {
    return;
  }
  await manager.query(
    `
      INSERT INTO "current_zone_recompute_request" (
        "departementId", "generation", "requestedAt",
        "lastAttemptAt", "attemptCount", "lastError",
        "targetPublicRevision", "reason", "scheduledFor",
        "pendingScheduledDates", "currentPending",
        "nextAttemptAt", "supersededCount"
      )
      SELECT departement_id, 1, now(), NULL, 0, NULL,
        $2::bigint, left($3, 100), $4::date,
        CASE
          WHEN $4::date IS NULL THEN '{}'::date[]
          ELSE ARRAY[$4::date]
        END,
        $4::date IS NULL,
        now(), 0
      FROM unnest($1::integer[]) AS departement_id
      ON CONFLICT ("departementId") DO UPDATE
      SET
        "generation" = CASE
          WHEN "current_zone_recompute_request"."targetPublicRevision" =
              EXCLUDED."targetPublicRevision"
            AND (
              (
                EXCLUDED."scheduledFor" IS NULL
                AND "current_zone_recompute_request"."currentPending"
              )
              OR EXCLUDED."scheduledFor" = ANY(
                "current_zone_recompute_request"."pendingScheduledDates"
              )
            )
          THEN "current_zone_recompute_request"."generation"
          ELSE "current_zone_recompute_request"."generation" + 1
        END,
        "requestedAt" = CASE
          WHEN "current_zone_recompute_request"."targetPublicRevision" =
              EXCLUDED."targetPublicRevision"
            AND (
              (
                EXCLUDED."scheduledFor" IS NULL
                AND "current_zone_recompute_request"."currentPending"
              )
              OR EXCLUDED."scheduledFor" = ANY(
                "current_zone_recompute_request"."pendingScheduledDates"
              )
            )
          THEN "current_zone_recompute_request"."requestedAt"
          ELSE now()
        END,
        "lastAttemptAt" = CASE
          WHEN "current_zone_recompute_request"."targetPublicRevision" =
              EXCLUDED."targetPublicRevision"
            AND (
              (
                EXCLUDED."scheduledFor" IS NULL
                AND "current_zone_recompute_request"."currentPending"
              )
              OR EXCLUDED."scheduledFor" = ANY(
                "current_zone_recompute_request"."pendingScheduledDates"
              )
            )
          THEN "current_zone_recompute_request"."lastAttemptAt"
          ELSE NULL
        END,
        "attemptCount" = CASE
          WHEN "current_zone_recompute_request"."targetPublicRevision" =
              EXCLUDED."targetPublicRevision"
            AND (
              (
                EXCLUDED."scheduledFor" IS NULL
                AND "current_zone_recompute_request"."currentPending"
              )
              OR EXCLUDED."scheduledFor" = ANY(
                "current_zone_recompute_request"."pendingScheduledDates"
              )
            )
          THEN "current_zone_recompute_request"."attemptCount"
          ELSE 0
        END,
        "lastError" = NULL,
        "targetPublicRevision" = EXCLUDED."targetPublicRevision",
        "reason" = EXCLUDED."reason",
        "scheduledFor" = (
          SELECT MIN(pending_date)
          FROM unnest(
            "current_zone_recompute_request"."pendingScheduledDates"
              || EXCLUDED."pendingScheduledDates"
          ) AS dates(pending_date)
        ),
        "pendingScheduledDates" = ARRAY(
          SELECT DISTINCT pending_date
          FROM unnest(
            "current_zone_recompute_request"."pendingScheduledDates"
              || EXCLUDED."pendingScheduledDates"
          ) AS dates(pending_date)
          ORDER BY pending_date
        ),
        "currentPending" =
          "current_zone_recompute_request"."currentPending"
          OR EXCLUDED."currentPending",
        "nextAttemptAt" = CASE
          WHEN "current_zone_recompute_request"."targetPublicRevision" =
              EXCLUDED."targetPublicRevision"
            AND (
              (
                EXCLUDED."scheduledFor" IS NULL
                AND "current_zone_recompute_request"."currentPending"
              )
              OR EXCLUDED."scheduledFor" = ANY(
                "current_zone_recompute_request"."pendingScheduledDates"
              )
            )
          THEN "current_zone_recompute_request"."nextAttemptAt"
          ELSE now()
        END
    `,
    [ids, targetPublicRevision, reason, scheduledFor ?? null],
  );
}

export async function recordPublicMutation(
  manager: EntityManager,
  departementIds: number[],
  reason: string,
): Promise<string> {
  const ids = [...new Set(departementIds)].sort((left, right) => left - right);
  if (ids.length === 0) {
    throw new Error('A public mutation must target at least one department');
  }
  const result = await manager.query(`
    UPDATE "zone_publication_source_state"
    SET
      "publicRevision" = "publicRevision" + CASE
        WHEN "legacyDualWrite" THEN 0
        ELSE 1
      END,
      "updatedAt" = now()
    WHERE "id" = 1
    RETURNING "publicRevision"
  `);
  const [sourceState] = unwrapTypeOrmDmlReturningRows<{
    publicRevision: string;
  }>(result);
  if (!sourceState) {
    throw new Error('Zone publication source state is missing');
  }
  const publicRevision = String(sourceState.publicRevision);
  // Keep the last successful certification public while its replacement is
  // computed. The recompute queue carries the pending state exposed by the API.
  await enqueueCurrentZoneRecomputeTarget(manager, ids, publicRevision, reason);
  return publicRevision;
}

export async function certifyAvailableZoneTypes(
  manager: Pick<EntityManager, 'query'>,
  departementIds: number[],
  publicRevision: string,
): Promise<void> {
  const ids = [...new Set(departementIds)].sort((left, right) => left - right);
  if (ids.length === 0) {
    return;
  }
  await manager.query(
    `
      INSERT INTO "zone_type_availability" (
        "departmentCode", "zoneType", "status", "asOf",
        "publicRevision", "officialUrl", "updatedAt"
      )
      SELECT DISTINCT
        departement."code", zone."type", 'available', now(),
        source."publicRevision", NULL, now()
      FROM "zone_alerte_computed" zone
      INNER JOIN "departement" departement
        ON departement."id" = zone."departementId"
      CROSS JOIN "zone_publication_source_state" source
      WHERE departement."id" = ANY($1::integer[])
        AND zone."type" IN ('SOU', 'SUP', 'AEP')
        AND source."id" = 1
        AND source."publicRevision" = $2::bigint
      ON CONFLICT ("departmentCode", "zoneType") DO UPDATE
      SET
        "status" = 'available',
        "asOf" = EXCLUDED."asOf",
        "publicRevision" = EXCLUDED."publicRevision",
        "updatedAt" = now()
    `,
    [ids, publicRevision],
  );
}

export async function certifyZoneTypeAvailability(
  manager: EntityManager,
  departementId: number,
  zoneType: PublicZoneType,
  status: CertifiedZoneTypeAvailability,
  publicRevision: string,
  officialUrl?: string,
  asOf = new Date(),
): Promise<void> {
  if (!['AEP', 'SOU', 'SUP'].includes(zoneType)) {
    throw new Error(`Unsupported public zone type: ${String(zoneType)}`);
  }
  if (!['available', 'confirmed_none'].includes(status)) {
    throw new Error(`Unsupported zone availability status: ${String(status)}`);
  }
  const result = await manager.query(
    `
      INSERT INTO "zone_type_availability" (
        "departmentCode", "zoneType", "status", "asOf",
        "publicRevision", "officialUrl", "updatedAt"
      )
      SELECT
        departement."code", $2, $3, $4, source."publicRevision",
        $5, now()
      FROM "departement" departement
      CROSS JOIN "zone_publication_source_state" source
      WHERE departement."id" = $1
        AND source."id" = 1
        AND source."publicRevision" = $6::bigint
        AND (
          $3 <> 'confirmed_none'
          OR (
            NOT EXISTS (
              SELECT 1
              FROM "zone_alerte_computed" zone
              WHERE zone."departementId" = departement."id"
                AND zone."type" = $2
            )
            AND NOT EXISTS (
              SELECT 1
              FROM "current_zone_recompute_request" pending
              WHERE pending."departementId" = departement."id"
            )
          )
        )
      ON CONFLICT ("departmentCode", "zoneType") DO UPDATE
      SET
        "status" = EXCLUDED."status",
        "asOf" = EXCLUDED."asOf",
        "publicRevision" = EXCLUDED."publicRevision",
        "officialUrl" = COALESCE(
          EXCLUDED."officialUrl",
          "zone_type_availability"."officialUrl"
        ),
        "updatedAt" = now()
      RETURNING "departmentCode"
    `,
    [
      departementId,
      zoneType,
      status,
      asOf,
      officialUrl ?? null,
      publicRevision,
    ],
  );
  const rows = unwrapTypeOrmDmlReturningRows<{ departmentCode: string }>(
    result,
  );
  if (rows.length !== 1) {
    throw new ZoneAvailabilityCertificationSupersededError(
      `Zone availability certification was superseded for department ${departementId}`,
    );
  }
}
