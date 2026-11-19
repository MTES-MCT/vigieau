import { DataSource } from 'typeorm';
import { APPROVED_HISTORY_V3_RUN } from './approved-history-v3';
import { CurrentStatisticPriorityError } from './restore-missing-commune-history';
import {
  EQUIVALENCE_ANCHOR,
  ApprovedHistoryAnchor,
  LATEST_APPROVED_HISTORY_ANCHOR_SQL,
  EQUIVALENCE_INSPECTION_SETTINGS_SQL,
  applyEquivalenceAttestation,
  assertEquivalenceAnchorInputs,
  assertEquivalenceAudit,
  equivalenceOperatorDigest,
  equivalenceProof,
  inspectEquivalenceState,
  releaseEquivalenceRunner,
} from './attest-history-by-source-equivalence';

export const AUTOMATIC_HISTORY_EQUIVALENCE_LOCK =
  'vigieau:history:automatic-source-equivalence';

// Only the already verified repair is eligible. A newer restoration must not
// accidentally be replaced with this older trust anchor. No backup download,
// geometry replay or historical-data rewrite is performed by this worker.
export const AUTOMATIC_HISTORY_EQUIVALENCE_PREFLIGHT_SQL = `
WITH latest AS (SELECT * FROM certified_history_repair_audit
  ORDER BY "promotedAt" DESC, id DESC LIMIT 1)
SELECT current_database() AS database,
  to_jsonb(latest) AS audit, latest.id::text AS "latestRepairId",
  (SELECT "attestationId" FROM active_certified_history_repair WHERE id=latest.id) AS "activeAttestationId",
  EXISTS(SELECT 1 FROM certified_history_repair_attestation
    WHERE id=$2 AND "repairId"=$1 AND "attestedThroughEpoch"=$3) AS "anchorPresent",
  (SELECT to_jsonb(original) FROM (${LATEST_APPROVED_HISTORY_ANCHOR_SQL}) original) AS "approvedAnchor"
FROM latest
`;

export interface AutomaticHistoryEquivalenceResult {
  status:
    | 'ATTESTED'
    | 'ALREADY_ATTESTED'
    | 'NOT_APPLICABLE'
    | 'BUSY'
    | 'DRY_RUN';
  attestationId?: string;
  revision?: string;
  proof?: string;
}

/**
 * Recover conservatively invalidated statistics only when ALL statistical
 * inputs and outputs still match the independently pinned certified repair.
 * Real changes fail closed: keep provisional data, report for bounded replay.
 * Unlike the operator's initial attestation, this trusts the already pinned
 * input digest AND original database audit/attestation; it cannot create a new
 * trust anchor. The full original inspection and publication guards still run.
 */
export async function automaticallyAttestHistoryBySourceEquivalence(
  target: DataSource,
  options: { apply?: boolean } = {},
): Promise<AutomaticHistoryEquivalenceResult> {
  // One connection owns the session lease while the other performs the bounded
  // read/commit. Fail promptly instead of deadlocking a single-connection pool.
  if ((target.options?.extra?.max ?? 10) < 2)
    throw new Error(
      'Automatic history recovery needs a database pool of at least 2',
    );
  const lease = target.createQueryRunner();
  await lease.connect();
  let locked = false;
  let operationFailed = false;
  try {
    await lease.startTransaction('READ COMMITTED');
    await lease.query('SET TRANSACTION READ ONLY');
    await lease.query(EQUIVALENCE_INSPECTION_SETTINGS_SQL);
    const [lock] = await lease.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [AUTOMATIC_HISTORY_EQUIVALENCE_LOCK],
    );
    locked = lock?.locked === true;
    if (!locked) return { status: 'BUSY' };
    const [state] = await lease.query(
      AUTOMATIC_HISTORY_EQUIVALENCE_PREFLIGHT_SQL,
      [
        EQUIVALENCE_ANCHOR.repairId,
        EQUIVALENCE_ANCHOR.attestationId,
        EQUIVALENCE_ANCHOR.historicComputeEpoch,
      ],
    );
    await lease.commitTransaction();
    if (!state?.audit) return { status: 'NOT_APPLICABLE' };
    const approvedAnchor: ApprovedHistoryAnchor | undefined =
      state.audit.sourceRunId === APPROVED_HISTORY_V3_RUN
        ? state.approvedAnchor
        : undefined;
    if (state.audit.sourceRunId === APPROVED_HISTORY_V3_RUN && !approvedAnchor)
      throw new Error(
        'Original approved historical promotion trust anchor is missing',
      );
    if (
      state.latestRepairId !== (approvedAnchor ?? EQUIVALENCE_ANCHOR).repairId
    )
      return { status: 'NOT_APPLICABLE' };
    assertEquivalenceAudit(state.audit, approvedAnchor);
    if (!approvedAnchor && state.anchorPresent !== true)
      throw new Error('Original certified history trust anchor is missing');
    if (state.activeAttestationId)
      return {
        status: 'ALREADY_ATTESTED',
        attestationId: state.activeAttestationId,
      };

    // The session advisory lock is held on a dedicated connection, without an
    // idle transaction or a lock on any application row during inspection.
    const current = await inspectEquivalenceState(
      target,
      state.database,
      false,
      await equivalenceOperatorDigest([__filename]),
      true,
      approvedAnchor,
    );
    assertEquivalenceAnchorInputs(current.inputs.digest, approvedAnchor);
    const proof = equivalenceProof(current);
    if (options.apply === false) return { status: 'DRY_RUN', proof };
    return {
      ...(await applyEquivalenceAttestation(target, current, proof)),
      proof,
    };
  } catch (error) {
    const postgresCode =
      error && typeof error === 'object'
        ? ((error as { code?: string; driverError?: { code?: string } }).code ??
          (error as { driverError?: { code?: string } }).driverError?.code)
        : undefined;
    if (
      error instanceof CurrentStatisticPriorityError ||
      postgresCode === '55P03'
    ) {
      // Expected contention is deferred, not a failed source verification.
      // Keep operationFailed=false so a genuine cleanup failure still throws.
      return { status: 'BUSY' };
    }
    operationFailed = true;
    throw error;
  } finally {
    // Session locks must be released on exactly the connection that acquired
    // them, including failures, unavailable locks and dry-run paths.
    let cleanupError: unknown;
    try {
      if (lease.isTransactionActive) await lease.rollbackTransaction();
    } catch (error) {
      cleanupError = error;
    }
    try {
      if (locked) {
        const [unlock] = await lease.query(
          'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
          [AUTOMATIC_HISTORY_EQUIVALENCE_LOCK],
        );
        if (unlock?.unlocked !== true)
          throw new Error(
            'Automatic history recovery session lease was not released',
          );
      }
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) {
      // Never return a possibly locked/aborted session to the application pool.
      // This is the same pool-destroying Postgres release used by zone workers.
      try {
        await (
          lease as typeof lease & {
            releasePostgresConnection: (error: Error) => Promise<void>;
          }
        ).releasePostgresConnection(
          cleanupError instanceof Error
            ? cleanupError
            : new Error(String(cleanupError)),
        );
      } catch (error) {
        cleanupError ??= error;
      }
      if (!operationFailed) throw cleanupError;
    } else {
      await releaseEquivalenceRunner(lease, operationFailed);
    }
  }
}
