import 'reflect-metadata';
import 'dotenv/config';
import { open, readFile } from 'fs/promises';
import { resolve } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { DataSource, QueryRunner } from 'typeorm';
import {
  fetchSandreZoneSnapshot,
  SandreZoneSnapshot,
} from '../zone_alerte/sandre-zone-sync';
import {
  BlockingCollision,
  buildReconciliationResults,
  DatabaseAliasState,
  DatabaseArreteCadreLink,
  DatabaseCustomizationState,
  DatabaseRestrictionState,
  DatabaseZoneState,
  discoverGenealogyCsvUrl,
  earliestMappedRestrictionDate,
  findBlockingCollisions,
  fingerprint,
  LocalZoneRecord,
  mappingsFromResults,
  normalizeDatabaseState,
  OfficialZoneRecord,
  parseGenealogyCsv,
  ReconciliationDatabaseState,
  ReconciliationMapping,
  reconciliationIdentity,
  ReconciliationResult,
  SANDRE_GENEALOGY_METADATA_URL,
  SandreGenealogyRelation,
  transformDatabaseState,
  ZoneReferenceCounts,
} from '../zone_alerte/sandre-zone-reconciliation';
import {
  isStrictOneToOneGeometry,
  parseSandreForceFullAuditAfter,
  parseSandreZoneSyncMode,
  STRICT_GEOMETRY_THRESHOLDS,
  StrictGeometryEvidence,
} from '../zone_alerte/sandre-zone-governance';
import {
  applySandreReconciliationActions,
  auditSandreReconciliationPlan,
  auditSandreSyncExpectations,
  loadSandreReconciliationState,
  lockSandreReconciliationPlan,
  OfficialSandreGeometry,
  OfficialSandreSnapshot,
  parseSandreReconciliationPlan,
  reconciliationPlanFingerprint,
  SandreActionAudit,
  SandreReconciliationPlan,
  SandreSyncExpectationEvidence,
} from '../zone_alerte/sandre-zone-reconciliation-actions';

export const RECONCILIATION_REPORT_VERSION = 6;
export const SANDRE_OPERATION_REPORT_VERSION = 3;
const MAX_SOURCE_SIZE = 10 * 1024 * 1024;
const HISTORICAL_RECOMPUTE_LOCK_TIMEOUT_MS = 60 * 60 * 1000;

export interface CliOptions {
  apply: boolean;
  departments: string[];
  mappingPairs: ManualMappingPair[];
  operationPlanPath: string | null;
  recordDecisions: boolean;
  reportPath: string | null;
  verifyPostSafe: boolean;
}

export interface ManualMappingPair {
  oldZoneId: number;
  newZoneId: number;
}

interface ManualMappingEvidence extends StrictGeometryEvidence {
  oldZoneId: number;
  newZoneId: number;
}

interface DepartmentRow {
  id: number;
  code: string;
}

interface SourceEvidence {
  metadataUrl: string;
  metadataSha256: string;
  csvUrl: string;
  csvSha256: string;
  genealogyRows: number;
  snapshots: Array<{
    departmentCode: string;
    featureCount: number;
    snapshotHash: string;
    sourceUpdatedAt: string | null;
  }>;
  fingerprint: string;
}

interface ReconciliationReport {
  version: number;
  generatedAt: string;
  targetFingerprint: string;
  scope: {
    departments: string[];
  };
  source: SourceEvidence;
  applicationPolicy: 'official_strict_1to1' | 'manual_dry_run_only';
  geometryEvidence: ManualMappingEvidence[];
  candidateFingerprint: string;
  mappingFingerprint: string;
  database: {
    beforeFingerprint: string;
    afterFingerprint: string;
    historicalRecomputeFrom: string | null;
  };
  summary: {
    applicable: number;
    ambiguous: number;
    noOfficialSuccessor: number;
    blockingCollisions: number;
    selectedMappings: number;
  };
  results: ReconciliationResult[];
  mappings: ReconciliationMapping[];
  collisions: BlockingCollision[];
  reportFingerprint: string;
}

interface SandreOperationReport {
  kind: 'audited_sandre_operation';
  version: number;
  generatedAt: string;
  targetFingerprint: string;
  plan: SandreReconciliationPlan;
  planFingerprint: string;
  officialSource: OperationOfficialSourceEvidence;
  syncEvidence: SandreSyncExpectationEvidence[];
  audits: SandreActionAudit[];
  database: {
    beforeFingerprint: string;
    afterFingerprint: string;
    afterBusinessReferencesFingerprint: string;
    historicalRecomputeFrom: string | null;
  };
  reportFingerprint: string;
}

interface Analysis {
  departments: DepartmentRow[];
  source: SourceEvidence;
  applicationPolicy: ReconciliationReport['applicationPolicy'];
  geometryEvidence: ManualMappingEvidence[];
  relations: SandreGenealogyRelation[];
  officialZones: OfficialZoneRecord[];
  localZones: LocalZoneRecord[];
  results: ReconciliationResult[];
  mappings: ReconciliationMapping[];
  databaseState: ReconciliationDatabaseState;
  collisions: BlockingCollision[];
  databaseBeforeFingerprint: string;
  databaseAfterFingerprint: string;
  historicalRecomputeFrom: string | null;
  candidateFingerprint: string;
  mappingFingerprint: string;
}

export interface QueryExecutor {
  query(query: string, parameters?: any[]): Promise<any[]>;
}

export interface RecomputeDebt {
  departmentId: number;
  revision: number;
}

interface OperationOfficialSource {
  features: OfficialSandreGeometry[];
  snapshots: OfficialSandreSnapshot[];
}

interface OperationOfficialSourceEvidence {
  snapshots: Array<{
    departmentCode: string;
    snapshotHash: string;
    sourceUpdatedAt: string | null;
    featureCount: number;
  }>;
  fingerprint: string;
}

export interface SandrePostSafeVerification {
  departments: Array<{
    departmentCode: string;
    appliedSnapshotHash: string;
    appliedSourceUpdatedAt: string | null;
    appliedFeatureCount: number;
    lastAppliedAt: string;
    latestBatchStatus: string;
  }>;
  invalidReferences: {
    arreteRestrictions: number;
    arreteCadres: number;
    customizations: number;
    total: number;
  };
  health: {
    totalDepartments: number;
    trackedDepartments: number;
    staleDepartments: number;
    forcedAuditCompletedDepartments: number;
    appliedDepartments: number;
    staleAppliedDepartments: number;
    pendingApplicationDepartments: number;
    blockedDepartments: number;
    recomputePendingDepartments: number;
    failedBatches: number;
    blockedBatches: number;
  };
}

interface ApplyMappingsResult {
  status: 'APPLIED' | 'ALREADY_APPLIED';
  recomputeDebts: RecomputeDebt[];
}

function createStandaloneDataSource(): DataSource {
  const user = requiredEnvironmentVariable('DATABASE_USER');
  const password = requiredEnvironmentVariable('DATABASE_PASSWORD');
  const host = requiredEnvironmentVariable('DATABASE_HOST');
  const port = requiredEnvironmentVariable('DATABASE_PORT');
  const database = requiredEnvironmentVariable('DATABASE_NAME');
  const sslEnabled = process.env.NODE_ENV !== 'local';
  const sslQuery = process.env.DATABASE_SSL_CERT ? '?sslmode=require' : '';

  return new DataSource({
    type: 'postgres',
    url: `postgres://${user}:${password}@${host}:${port}/${database}${sslQuery}`,
    ssl: sslEnabled,
    extra: sslEnabled
      ? {
          ssl: {
            rejectUnauthorized: false,
          },
        }
      : {},
  });
}

export function currentTargetFingerprint(): string {
  return fingerprint({
    databaseHost: requiredEnvironmentVariable('DATABASE_HOST'),
    databasePort: requiredEnvironmentVariable('DATABASE_PORT'),
    databaseName: requiredEnvironmentVariable('DATABASE_NAME'),
    scalingoApp: process.env.SCALINGO_APP?.trim() || null,
    nodeEnvironment: process.env.NODE_ENV?.trim() || null,
  });
}

async function rollbackTransactionPreservingError(
  queryRunner: QueryRunner,
  primaryError: unknown,
  context: string,
): Promise<void> {
  if (!queryRunner.isTransactionActive) {
    return;
  }
  try {
    await queryRunner.rollbackTransaction();
  } catch (cleanupError) {
    if (primaryError !== undefined) {
      console.error(
        `[sandre-reconcile] ${context} rollback failed`,
        cleanupError,
      );
      return;
    }
    throw cleanupError;
  }
}

export async function rollbackAndReleaseQueryRunner(
  queryRunner: QueryRunner,
  primaryError: unknown,
  context: string,
): Promise<void> {
  let cleanupError: unknown;
  try {
    await rollbackTransactionPreservingError(queryRunner, undefined, context);
  } catch (error) {
    cleanupError = error;
  }
  try {
    await queryRunner.release();
  } catch (error) {
    cleanupError ??= error;
  }
  if (!cleanupError) {
    return;
  }
  if (primaryError !== undefined) {
    console.error(`[sandre-reconcile] ${context} cleanup failed`, cleanupError);
    return;
  }
  throw cleanupError;
}

async function runAuditedOperation(
  options: CliOptions,
  approvedReport: SandreOperationReport | null,
): Promise<void> {
  const plan = approvedReport
    ? approvedReport.plan
    : parseSandreReconciliationPlan(
        JSON.parse(
          await readFile(resolve(options.operationPlanPath!), 'utf8'),
        ) as unknown,
      );
  if (
    approvedReport &&
    approvedReport.targetFingerprint !== currentTargetFingerprint()
  ) {
    throw new Error(
      'The approved operation was generated for another database target',
    );
  }

  const dataSource = createStandaloneDataSource();
  await dataSource.initialize();
  let globalLock: QueryRunner | null = null;
  let operationError: unknown;
  let recomputeDebts: RecomputeDebt[] = [];
  let outcome: 'APPLIED' | 'ALREADY_APPLIED' | null = null;
  try {
    globalLock = await acquireSandreGlobalLock(dataSource);
    const officialSource = await loadOperationOfficialSource(plan);
    if (options.verifyPostSafe) {
      if (!approvedReport) {
        throw new Error('Missing approved Sandre operation report');
      }
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction('REPEATABLE READ');
      let verificationError: unknown;
      try {
        await queryRunner.query('SET TRANSACTION READ ONLY');
        assertOfficialSourceMatchesReport(officialSource, approvedReport);
        const currentSyncEvidence = await auditSandreSyncExpectations(
          queryRunner,
          plan,
          officialSource.snapshots,
        );
        if (
          fingerprint(currentSyncEvidence) !==
          fingerprint(approvedReport.syncEvidence)
        ) {
          throw new Error(
            'Sandre sync expectation evidence differs from the approved operation report',
          );
        }
        const currentAudits = await auditSandreReconciliationPlan(
          queryRunner,
          plan,
          officialSource.features,
        );
        if (currentAudits.some((audit) => audit.status !== 'already_applied')) {
          throw new Error(
            'Sandre reconciliation actions are not fully applied',
          );
        }
        const currentState = await loadSandreReconciliationState(
          queryRunner,
          plan,
        );
        if (
          operationBusinessReferencesFingerprint(currentState) !==
          approvedReport.database.afterBusinessReferencesFingerprint
        ) {
          throw new Error(
            'Sandre reconciliation business references differ from the approved result',
          );
        }
        const verification = await verifySandrePostSafeConvergence(
          queryRunner,
          officialSource.snapshots,
          getPostSafeHealthConfig(),
        );
        process.stdout.write(
          `${JSON.stringify({
            status: 'POST_SAFE_VERIFIED',
            operationId: plan.operationId,
            ...verification,
          })}\n`,
        );
      } catch (error) {
        verificationError = error;
        throw error;
      } finally {
        await rollbackAndReleaseQueryRunner(
          queryRunner,
          verificationError,
          'post-safe verification',
        );
      }
      return;
    }
    if (!options.apply) {
      const report = await simulateAuditedOperation(
        dataSource,
        plan,
        officialSource,
      );
      const json = `${JSON.stringify(report, null, 2)}\n`;
      if (options.reportPath) {
        const reportPath = resolve(options.reportPath);
        await writeReportFile(reportPath, json);
        console.error(`[sandre-reconcile] report written to ${reportPath}`);
      } else {
        process.stdout.write(json);
      }
      return;
    }

    if (!approvedReport) {
      throw new Error('Missing approved Sandre operation report');
    }
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    let historicalLockAcquired = false;
    let applyError: unknown;
    try {
      historicalLockAcquired = await acquireHistoricalRecomputeLock(
        queryRunner,
        approvedReport.database.historicalRecomputeFrom,
      );
      await queryRunner.startTransaction('SERIALIZABLE');
      const departmentIds = [
        ...new Set(approvedReport.audits.map((audit) => audit.departmentId)),
      ].sort((left, right) => left - right);
      for (const departmentId of departmentIds) {
        await queryRunner.query(
          "SELECT pg_advisory_xact_lock(hashtext('vigieau:sandre-zone-sync'), $1)",
          [departmentId],
        );
      }
      await lockSandreReconciliationPlan(queryRunner, plan);
      const transactionOfficialSource = await loadOperationOfficialSource(plan);
      assertOfficialSourceUnchanged(
        officialSource,
        transactionOfficialSource,
        'while opening the apply transaction',
      );
      assertOfficialSourceMatchesReport(
        transactionOfficialSource,
        approvedReport,
      );
      const currentSyncEvidence = await auditSandreSyncExpectations(
        queryRunner,
        plan,
        transactionOfficialSource.snapshots,
      );
      if (
        fingerprint(currentSyncEvidence) !==
        fingerprint(approvedReport.syncEvidence)
      ) {
        throw new Error(
          'Sandre sync expectation evidence differs from the approved operation report',
        );
      }
      const currentAudits = await auditSandreReconciliationPlan(
        queryRunner,
        plan,
        transactionOfficialSource.features,
      );
      if (currentAudits.every((audit) => audit.status === 'already_applied')) {
        const currentState = await loadSandreReconciliationState(
          queryRunner,
          plan,
        );
        if (
          fingerprint(currentState) !== approvedReport.database.afterFingerprint
        ) {
          throw new Error(
            'Applied Sandre state differs from the approved operation report',
          );
        }
        outcome = 'ALREADY_APPLIED';
        recomputeDebts = await prepareSandreOperationRecomputeDebt(
          queryRunner,
          outcome,
          departmentIds,
          approvedReport.database.historicalRecomputeFrom,
        );
      } else {
        const currentState = await loadSandreReconciliationState(
          queryRunner,
          plan,
        );
        if (
          fingerprint(currentState) !==
          approvedReport.database.beforeFingerprint
        ) {
          throw new Error(
            'Locked database state differs from the approved operation report',
          );
        }
        if (fingerprint(currentAudits) !== fingerprint(approvedReport.audits)) {
          throw new Error(
            'Reconciliation evidence differs from the approved operation report',
          );
        }
        await applySandreReconciliationActions(queryRunner, currentAudits);
        const finalAudits = await auditSandreReconciliationPlan(
          queryRunner,
          plan,
          transactionOfficialSource.features,
        );
        if (finalAudits.some((audit) => audit.status !== 'already_applied')) {
          throw new Error(
            'Sandre reconciliation postconditions are incomplete',
          );
        }
        const finalState = await loadSandreReconciliationState(
          queryRunner,
          plan,
        );
        if (
          fingerprint(finalState) !== approvedReport.database.afterFingerprint
        ) {
          throw new Error(
            'Final Sandre state differs from the approved operation report',
          );
        }
        recomputeDebts = await prepareSandreOperationRecomputeDebt(
          queryRunner,
          'APPLIED',
          departmentIds,
          approvedReport.database.historicalRecomputeFrom,
        );
        outcome = 'APPLIED';
      }
      const confirmedOfficialSource = await loadOperationOfficialSource(plan);
      assertOfficialSourceUnchanged(
        transactionOfficialSource,
        confirmedOfficialSource,
        'during the apply transaction',
      );
      await queryRunner.commitTransaction();
    } catch (error) {
      applyError = error;
      await rollbackTransactionPreservingError(queryRunner, error, 'apply');
      throw error;
    } finally {
      try {
        await releaseReconciliationResources(
          queryRunner,
          historicalLockAcquired,
        );
      } catch (cleanupError) {
        if (!applyError) {
          throw cleanupError;
        }
        console.error('[sandre-reconcile] apply cleanup failed', cleanupError);
      }
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    if (globalLock) {
      try {
        await releaseSandreGlobalLock(globalLock);
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      await dataSource.destroy();
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) {
      if (!operationError) {
        throw cleanupError;
      }
      console.error('[sandre-reconcile] cleanup failed', cleanupError);
    }
  }

  const departmentIds = recomputeDebts.map((debt) => debt.departmentId);
  try {
    if (departmentIds.length > 0) {
      await recomputeDepartments(departmentIds);
      await clearRecomputeDebt(recomputeDebts);
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        status: 'APPLIED_RECOMPUTE_FAILED',
        databaseStatus: outcome,
        operationId: plan.operationId,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    throw error;
  }
  process.stdout.write(
    `${JSON.stringify({
      status: outcome,
      operationId: plan.operationId,
      actions: plan.actions.length,
      recomputedDepartments: departmentIds,
    })}\n`,
  );
}

async function simulateAuditedOperation(
  dataSource: DataSource,
  plan: SandreReconciliationPlan,
  officialSource: OperationOfficialSource,
): Promise<SandreOperationReport> {
  const previewRunner = dataSource.createQueryRunner();
  await previewRunner.connect();
  let syncEvidence: SandreSyncExpectationEvidence[];
  let audits: SandreActionAudit[];
  let beforeState: Awaited<ReturnType<typeof loadSandreReconciliationState>>;
  let previewError: unknown;
  try {
    await previewRunner.startTransaction('REPEATABLE READ');
    await previewRunner.query('SET TRANSACTION READ ONLY');
    syncEvidence = await auditSandreSyncExpectations(
      previewRunner,
      plan,
      officialSource.snapshots,
    );
    audits = await auditSandreReconciliationPlan(
      previewRunner,
      plan,
      officialSource.features,
    );
    beforeState = await loadSandreReconciliationState(previewRunner, plan);
  } catch (error) {
    previewError = error;
    throw error;
  } finally {
    await rollbackAndReleaseQueryRunner(
      previewRunner,
      previewError,
      'dry-run preview',
    );
  }

  const historicalRecomputeFrom = earliestOperationRestrictionDate(beforeState);
  const departmentIds = [
    ...new Set(audits.map((audit) => audit.departmentId)),
  ].sort((left, right) => left - right);
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  let historicalLockAcquired = false;
  let simulationError: unknown;
  let afterState: Awaited<ReturnType<typeof loadSandreReconciliationState>>;
  try {
    historicalLockAcquired = await acquireHistoricalRecomputeLock(
      queryRunner,
      historicalRecomputeFrom,
    );
    await queryRunner.startTransaction('SERIALIZABLE');
    for (const departmentId of departmentIds) {
      await queryRunner.query(
        "SELECT pg_advisory_xact_lock(hashtext('vigieau:sandre-zone-sync'), $1)",
        [departmentId],
      );
    }
    await lockSandreReconciliationPlan(queryRunner, plan);

    const transactionOfficialSource = await loadOperationOfficialSource(plan);
    assertOfficialSourceUnchanged(
      officialSource,
      transactionOfficialSource,
      'while opening the dry-run transaction',
    );
    const transactionSyncEvidence = await auditSandreSyncExpectations(
      queryRunner,
      plan,
      transactionOfficialSource.snapshots,
    );
    const transactionAudits = await auditSandreReconciliationPlan(
      queryRunner,
      plan,
      transactionOfficialSource.features,
    );
    const transactionBeforeState = await loadSandreReconciliationState(
      queryRunner,
      plan,
    );
    if (
      fingerprint(transactionSyncEvidence) !== fingerprint(syncEvidence) ||
      fingerprint(transactionAudits) !== fingerprint(audits) ||
      fingerprint(transactionBeforeState) !== fingerprint(beforeState)
    ) {
      throw new Error('Sandre operation changed while opening its dry-run');
    }

    await applySandreReconciliationActions(queryRunner, transactionAudits);
    const finalAudits = await auditSandreReconciliationPlan(
      queryRunner,
      plan,
      transactionOfficialSource.features,
    );
    if (finalAudits.some((audit) => audit.status !== 'already_applied')) {
      throw new Error('Sandre dry-run postconditions are incomplete');
    }
    afterState = await loadSandreReconciliationState(queryRunner, plan);

    const confirmedOfficialSource = await loadOperationOfficialSource(plan);
    assertOfficialSourceUnchanged(
      transactionOfficialSource,
      confirmedOfficialSource,
      'during the dry-run transaction',
    );
    await queryRunner.rollbackTransaction();

    await queryRunner.startTransaction('REPEATABLE READ');
    await queryRunner.query('SET TRANSACTION READ ONLY');
    const restoredState = await loadSandreReconciliationState(
      queryRunner,
      plan,
    );
    if (fingerprint(restoredState) !== fingerprint(beforeState)) {
      throw new Error(
        'Sandre dry-run did not restore its initial database state',
      );
    }
    await queryRunner.rollbackTransaction();
  } catch (error) {
    simulationError = error;
    await rollbackTransactionPreservingError(
      queryRunner,
      error,
      'dry-run simulation',
    );
    throw error;
  } finally {
    try {
      await releaseReconciliationResources(queryRunner, historicalLockAcquired);
    } catch (cleanupError) {
      if (!simulationError) {
        throw cleanupError;
      }
      console.error('[sandre-reconcile] dry-run cleanup failed', cleanupError);
    }
  }

  return createOperationReport(
    plan,
    officialSource,
    syncEvidence,
    audits,
    beforeState,
    afterState,
  );
}

async function loadOperationOfficialSource(
  plan: SandreReconciliationPlan,
): Promise<OperationOfficialSource> {
  const canonicalActions = plan.actions.filter(
    (action) => action.strategy === 'canonicalize_duplicate',
  );
  const departmentCodes = [
    ...new Set([
      ...canonicalActions.map((action) => action.departmentCode),
      ...(plan.syncExpectations ?? []).map(
        (expectation) => expectation.departmentCode,
      ),
    ]),
  ].sort();
  const snapshots = await mapWithConcurrency(
    departmentCodes,
    2,
    async (departmentCode): Promise<OfficialSandreSnapshot> => {
      const snapshot = await fetchOfficialSnapshot(departmentCode);
      return {
        departmentCode,
        featureCount: snapshot.featureCount,
        snapshotHash: snapshot.snapshotHash,
        sourceUpdatedAt: snapshot.sourceUpdatedAt,
        features: snapshot.features.map((feature) => ({
          codeSandre: feature.codeSandre,
          gid: feature.gid,
          departmentCode: feature.departmentCode,
          type: feature.type,
          status: feature.status,
          payloadHash: feature.payloadHash,
          basinCode: feature.basinCode,
          geometry: feature.geometry,
        })),
      };
    },
  );
  return {
    features: snapshots.flatMap((snapshot) => snapshot.features),
    snapshots,
  };
}

function operationOfficialSourceEvidence(
  source: OperationOfficialSource,
): OperationOfficialSourceEvidence {
  const snapshots = source.snapshots
    .map((snapshot) => ({
      departmentCode: snapshot.departmentCode,
      snapshotHash: snapshot.snapshotHash,
      sourceUpdatedAt: snapshot.sourceUpdatedAt,
      featureCount: snapshot.featureCount,
    }))
    .sort((left, right) =>
      left.departmentCode.localeCompare(right.departmentCode),
    );
  return { snapshots, fingerprint: fingerprint(snapshots) };
}

function assertOfficialSourceUnchanged(
  expected: OperationOfficialSource,
  current: OperationOfficialSource,
  context: string,
): void {
  const expectedEvidence = operationOfficialSourceEvidence(expected);
  const currentEvidence = operationOfficialSourceEvidence(current);
  if (expectedEvidence.fingerprint !== currentEvidence.fingerprint) {
    throw new Error(`Sandre official source changed ${context}`);
  }
}

function assertOfficialSourceMatchesReport(
  source: OperationOfficialSource,
  report: SandreOperationReport,
): void {
  const evidence = operationOfficialSourceEvidence(source);
  if (
    evidence.fingerprint !== report.officialSource.fingerprint ||
    fingerprint(evidence.snapshots) !==
      fingerprint(report.officialSource.snapshots)
  ) {
    throw new Error(
      'Sandre official source differs from the approved operation report',
    );
  }
}

export async function verifySandrePostSafeConvergence(
  executor: QueryExecutor,
  snapshots: OfficialSandreSnapshot[],
  config: { staleAfterSeconds: number; forceFullAuditAfter: Date },
): Promise<SandrePostSafeVerification> {
  const departmentCodes = snapshots
    .map((snapshot) => snapshot.departmentCode)
    .sort();
  if (
    departmentCodes.length === 0 ||
    new Set(departmentCodes).size !== departmentCodes.length
  ) {
    throw new Error('Invalid post-safe department scope');
  }
  const departmentRows = await executor.query(
    `
      SELECT
        department.code AS "departmentCode",
        state."appliedSnapshotHash",
        state."appliedSourceUpdatedAt",
        state."appliedFeatureCount",
        state."lastAppliedAt",
        state."blockedAt",
        state."needsRecompute",
        latest.status AS "latestBatchStatus"
      FROM departement department
      LEFT JOIN sandre_zone_sync_state state
        ON state."departementId" = department.id
      LEFT JOIN LATERAL (
        SELECT batch.status
        FROM sandre_zone_sync_batch batch
        WHERE batch.kind = 'snapshot'
          AND batch."departementId" = department.id
        ORDER BY batch."startedAt" DESC, batch.id DESC
        LIMIT 1
      ) latest ON true
      WHERE department.code = ANY($1::text[])
      ORDER BY department.code
    `,
    [departmentCodes],
  );
  if (departmentRows.length !== snapshots.length) {
    throw new Error(
      `Post-safe state covers ${departmentRows.length}/${snapshots.length} departments`,
    );
  }
  const departments = snapshots
    .map((snapshot) => {
      const row = departmentRows.find(
        (candidate) => candidate.departmentCode === snapshot.departmentCode,
      );
      if (
        !row ||
        row.blockedAt !== null ||
        row.needsRecompute !== false ||
        row.appliedSnapshotHash !== snapshot.snapshotHash ||
        (row.appliedSourceUpdatedAt ?? null) !== snapshot.sourceUpdatedAt ||
        Number(row.appliedFeatureCount) !== snapshot.featureCount ||
        !row.lastAppliedAt ||
        row.latestBatchStatus !== 'applied'
      ) {
        throw new Error(
          `Post-safe synchronization has not converged for department ${snapshot.departmentCode}`,
        );
      }
      return {
        departmentCode: snapshot.departmentCode,
        appliedSnapshotHash: row.appliedSnapshotHash,
        appliedSourceUpdatedAt: row.appliedSourceUpdatedAt ?? null,
        appliedFeatureCount: Number(row.appliedFeatureCount),
        lastAppliedAt: new Date(row.lastAppliedAt).toISOString(),
        latestBatchStatus: row.latestBatchStatus,
      };
    })
    .sort((left, right) =>
      left.departmentCode.localeCompare(right.departmentCode),
    );

  const [referenceRow] = await executor.query(`
    SELECT
      (
        SELECT count(*)::integer
        FROM restriction reference
        JOIN arrete_restriction parent
          ON parent.id = reference."arreteRestrictionId"
        JOIN zone_alerte zone ON zone.id = reference."zoneAlerteId"
        WHERE zone.disabled = true
          AND parent.statut IN ('a_venir', 'publie')
      ) AS "arreteRestrictions",
      (
        SELECT count(*)::integer
        FROM arrete_cadre_zone_alerte reference
        JOIN arrete_cadre parent ON parent.id = reference."arreteCadreId"
        JOIN zone_alerte zone ON zone.id = reference."zoneAlerteId"
        WHERE zone.disabled = true
          AND parent.statut IN ('a_venir', 'publie')
      ) AS "arreteCadres",
      (
        SELECT count(*)::integer
        FROM arrete_cadre_zone_alerte_communes reference
        JOIN arrete_cadre parent ON parent.id = reference."arreteCadreId"
        JOIN zone_alerte zone ON zone.id = reference."zoneAlerteId"
        WHERE zone.disabled = true
          AND parent.statut IN ('a_venir', 'publie')
      ) AS customizations
  `);
  const invalidReferences = {
    arreteRestrictions: Number(referenceRow?.arreteRestrictions ?? 0),
    arreteCadres: Number(referenceRow?.arreteCadres ?? 0),
    customizations: Number(referenceRow?.customizations ?? 0),
    total: 0,
  };
  invalidReferences.total =
    invalidReferences.arreteRestrictions +
    invalidReferences.arreteCadres +
    invalidReferences.customizations;
  if (invalidReferences.total !== 0) {
    throw new Error(
      `Post-safe health still has ${invalidReferences.total} disabled-zone operational references`,
    );
  }

  const [healthRow] = await executor.query(
    `
      WITH latest_batches AS (
        SELECT DISTINCT ON (batch."departementId")
          batch."departementId", batch.status
        FROM sandre_zone_sync_batch batch
        WHERE batch.kind = 'snapshot'
        ORDER BY batch."departementId", batch."startedAt" DESC, batch.id DESC
      ), latest_rollout_audits AS (
        SELECT DISTINCT ON (batch."departementId")
          batch."departementId", batch.status
        FROM sandre_zone_sync_batch batch
        WHERE batch.kind = 'snapshot'
          AND batch.mode = 'audit'
          AND batch."startedAt" >= $2::timestamptz
        ORDER BY batch."departementId", batch."startedAt" DESC, batch.id DESC
      ), completed_forced_audits AS (
        SELECT "departementId"
        FROM latest_rollout_audits
        WHERE status = 'observed'
      )
      SELECT
        count(DISTINCT department.id)::integer AS "totalDepartments",
        count(DISTINCT state."departementId")::integer AS "trackedDepartments",
        count(DISTINCT department.id) FILTER (
          WHERE state."lastObservedAt" IS NULL
             OR state."lastObservedAt" <
               now() - ($1::integer * interval '1 second')
        )::integer AS "staleDepartments",
        count(DISTINCT completed_forced_audits."departementId")::integer
          AS "forcedAuditCompletedDepartments",
        count(DISTINCT state."departementId") FILTER (
          WHERE state."lastAppliedAt" IS NOT NULL
        )::integer AS "appliedDepartments",
        count(DISTINCT department.id) FILTER (
          WHERE state."lastAppliedAt" IS NULL
             OR state."lastAppliedAt" <
               now() - ($1::integer * interval '1 second')
        )::integer AS "staleAppliedDepartments",
        count(DISTINCT state."departementId") FILTER (
          WHERE state."observedSnapshotHash" IS DISTINCT FROM
              state."appliedSnapshotHash"
             OR state."observedSourceUpdatedAt" IS DISTINCT FROM
              state."appliedSourceUpdatedAt"
        )::integer AS "pendingApplicationDepartments",
        count(DISTINCT state."departementId") FILTER (
          WHERE state."blockedAt" IS NOT NULL
        )::integer AS "blockedDepartments",
        count(DISTINCT state."departementId") FILTER (
          WHERE state."needsRecompute" = true
        )::integer AS "recomputePendingDepartments",
        count(DISTINCT latest_batches."departementId") FILTER (
          WHERE latest_batches.status = 'failed'
        )::integer AS "failedBatches",
        count(DISTINCT latest_batches."departementId") FILTER (
          WHERE latest_batches.status = 'blocked'
        )::integer AS "blockedBatches"
      FROM departement department
      LEFT JOIN sandre_zone_sync_state state
        ON state."departementId" = department.id
      LEFT JOIN latest_batches
        ON latest_batches."departementId" = department.id
      LEFT JOIN completed_forced_audits
        ON completed_forced_audits."departementId" = department.id
    `,
    [config.staleAfterSeconds, config.forceFullAuditAfter],
  );
  const health = {
    totalDepartments: Number(healthRow?.totalDepartments ?? 0),
    trackedDepartments: Number(healthRow?.trackedDepartments ?? 0),
    staleDepartments: Number(healthRow?.staleDepartments ?? 0),
    forcedAuditCompletedDepartments: Number(
      healthRow?.forcedAuditCompletedDepartments ?? 0,
    ),
    appliedDepartments: Number(healthRow?.appliedDepartments ?? 0),
    staleAppliedDepartments: Number(healthRow?.staleAppliedDepartments ?? 0),
    pendingApplicationDepartments: Number(
      healthRow?.pendingApplicationDepartments ?? 0,
    ),
    blockedDepartments: Number(healthRow?.blockedDepartments ?? 0),
    recomputePendingDepartments: Number(
      healthRow?.recomputePendingDepartments ?? 0,
    ),
    failedBatches: Number(healthRow?.failedBatches ?? 0),
    blockedBatches: Number(healthRow?.blockedBatches ?? 0),
  };
  if (
    health.totalDepartments === 0 ||
    health.trackedDepartments !== health.totalDepartments ||
    health.staleDepartments !== 0 ||
    health.forcedAuditCompletedDepartments !== health.totalDepartments ||
    health.appliedDepartments !== health.totalDepartments ||
    health.staleAppliedDepartments !== 0 ||
    health.pendingApplicationDepartments !== 0 ||
    health.blockedDepartments !== 0 ||
    health.recomputePendingDepartments !== 0 ||
    health.failedBatches !== 0 ||
    health.blockedBatches !== 0
  ) {
    throw new Error(
      `Post-safe global Sandre health has not converged: ${JSON.stringify(health)}`,
    );
  }
  return { departments, invalidReferences, health };
}

function getPostSafeHealthConfig(): {
  staleAfterSeconds: number;
  forceFullAuditAfter: Date;
} {
  if (parseSandreZoneSyncMode(process.env.SANDRE_ZONE_SYNC_MODE) !== 'safe') {
    throw new Error(
      'Post-safe verification requires SANDRE_ZONE_SYNC_MODE=safe',
    );
  }
  const forceFullAuditAfter = parseSandreForceFullAuditAfter(
    process.env.SANDRE_FORCE_FULL_AUDIT_AFTER,
  );
  if (!forceFullAuditAfter) {
    throw new Error(
      'Post-safe verification requires SANDRE_FORCE_FULL_AUDIT_AFTER',
    );
  }
  const configuredStaleAfter = Number(
    process.env.SANDRE_HEALTH_STALE_AFTER_SECONDS,
  );
  return {
    staleAfterSeconds:
      Number.isInteger(configuredStaleAfter) && configuredStaleAfter > 0
        ? configuredStaleAfter
        : 30 * 60 * 60,
    forceFullAuditAfter,
  };
}

function createOperationReport(
  plan: SandreReconciliationPlan,
  officialSource: OperationOfficialSource,
  syncEvidence: SandreSyncExpectationEvidence[],
  audits: SandreActionAudit[],
  beforeState: Awaited<ReturnType<typeof loadSandreReconciliationState>>,
  afterState: Awaited<ReturnType<typeof loadSandreReconciliationState>>,
): SandreOperationReport {
  const reportWithoutFingerprint = {
    kind: 'audited_sandre_operation' as const,
    version: SANDRE_OPERATION_REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    targetFingerprint: currentTargetFingerprint(),
    plan,
    planFingerprint: reconciliationPlanFingerprint(plan),
    officialSource: operationOfficialSourceEvidence(officialSource),
    syncEvidence,
    audits,
    database: {
      beforeFingerprint: fingerprint(beforeState),
      afterFingerprint: fingerprint(afterState),
      afterBusinessReferencesFingerprint:
        operationBusinessReferencesFingerprint(afterState),
      historicalRecomputeFrom: earliestOperationRestrictionDate(beforeState),
    },
  };
  return {
    ...reportWithoutFingerprint,
    reportFingerprint: fingerprint(reportWithoutFingerprint),
  };
}

async function readOperationReportIfPresent(
  reportPath: string | null,
): Promise<SandreOperationReport | null> {
  if (!reportPath) {
    return null;
  }
  const parsed = JSON.parse(
    await readFile(resolve(reportPath), 'utf8'),
  ) as Record<string, unknown>;
  if (parsed.kind !== 'audited_sandre_operation') {
    return null;
  }
  const report = parsed as unknown as SandreOperationReport;
  if (report.version !== SANDRE_OPERATION_REPORT_VERSION) {
    throw new Error(`Unsupported operation report version ${report.version}`);
  }
  if (
    !report.officialSource ||
    !Array.isArray(report.officialSource.snapshots) ||
    typeof report.officialSource.fingerprint !== 'string' ||
    fingerprint(report.officialSource.snapshots) !==
      report.officialSource.fingerprint
  ) {
    throw new Error('The approved operation source evidence is invalid');
  }
  if (
    !report.database ||
    !/^[a-f0-9]{64}$/.test(report.database.beforeFingerprint) ||
    !/^[a-f0-9]{64}$/.test(report.database.afterFingerprint) ||
    !/^[a-f0-9]{64}$/.test(
      report.database.afterBusinessReferencesFingerprint,
    ) ||
    (report.database.historicalRecomputeFrom !== null &&
      !/^\d{4}-\d{2}-\d{2}$/.test(report.database.historicalRecomputeFrom))
  ) {
    throw new Error('The approved operation database evidence is invalid');
  }
  const { reportFingerprint, ...unsignedReport } = report;
  if (fingerprint(unsignedReport) !== reportFingerprint) {
    throw new Error('The approved operation report fingerprint is invalid');
  }
  const plan = parseSandreReconciliationPlan(report.plan);
  if (reconciliationPlanFingerprint(plan) !== report.planFingerprint) {
    throw new Error('The approved operation plan fingerprint is invalid');
  }
  return { ...report, plan };
}

function earliestOperationRestrictionDate(
  state: Awaited<ReturnType<typeof loadSandreReconciliationState>>,
): string | null {
  return (
    state.restrictions
      .map((restriction) => restriction.arreteRestrictionDateDebut)
      .filter((date): date is string => typeof date === 'string')
      .sort()[0] ?? null
  );
}

export function operationBusinessReferencesFingerprint(
  state: Awaited<ReturnType<typeof loadSandreReconciliationState>>,
): string {
  return fingerprint({
    arreteCadreLinks: state.arreteCadreLinks,
    restrictions: state.restrictions,
    usages: state.usages,
    restrictionCommunes: state.restrictionCommunes,
    customizations: state.customizations,
    customizationCommunes: state.customizationCommunes,
  });
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const operationReport =
    options.apply || options.verifyPostSafe
      ? await readOperationReportIfPresent(options.reportPath)
      : null;
  if (options.operationPlanPath || operationReport) {
    await runAuditedOperation(options, operationReport);
    return;
  }
  const approvedReport = options.apply
    ? await readApprovedReport(options.reportPath)
    : null;
  if (
    approvedReport &&
    approvedReport.targetFingerprint !== currentTargetFingerprint()
  ) {
    throw new Error(
      'The approved report was generated for another database target',
    );
  }
  if (
    approvedReport &&
    approvedReport.applicationPolicy !== 'official_strict_1to1'
  ) {
    throw new Error('Manual geometry reports can never be applied');
  }
  const requestedDepartments =
    approvedReport?.scope.departments ?? options.departments;

  if (
    approvedReport &&
    options.departments.length > 0 &&
    fingerprint(options.departments) !==
      fingerprint(approvedReport.scope.departments)
  ) {
    throw new Error(
      '--department must exactly match the departments in the approved report',
    );
  }

  const dataSource = createStandaloneDataSource();
  await dataSource.initialize();

  let analysis: Analysis;
  let outcome: 'APPLIED' | 'ALREADY_APPLIED' | null = null;
  let recomputeDebts: RecomputeDebt[] = [];
  let globalLock: QueryRunner | null = null;
  let operationError: unknown;
  try {
    globalLock = await acquireSandreGlobalLock(dataSource);
    const alreadyApplied =
      approvedReport &&
      (await reportDatabaseStateIsAlreadyApplied(dataSource, approvedReport));
    if (alreadyApplied) {
      outcome = 'ALREADY_APPLIED';
      recomputeDebts = await recordRecomputeDebt(
        dataSource,
        approvedReport.mappings,
        approvedReport.database.historicalRecomputeFrom,
      );
    } else {
      analysis = await analyzeReadOnly(
        dataSource,
        requestedDepartments,
        approvedReport?.mappings,
        options.mappingPairs,
      );
    }

    if (!options.apply && analysis) {
      const report = createReport(analysis);
      const json = `${JSON.stringify(report, null, 2)}\n`;
      if (options.recordDecisions) {
        await recordReconciliationDecisions(dataSource, report);
      }
      if (options.reportPath) {
        const reportPath = resolve(options.reportPath);
        await writeReportFile(reportPath, json);
        console.error(`[sandre-reconcile] report written to ${reportPath}`);
      } else {
        process.stdout.write(json);
      }
      return;
    }

    if (!approvedReport) {
      throw new Error('Missing approved report');
    }
    if (!alreadyApplied) {
      assertAnalysisMatchesReport(analysis, approvedReport);
      if (analysis.collisions.length > 0) {
        throw new Error(
          `Apply blocked by ${analysis.collisions.length} relation collision(s)`,
        );
      }

      const applyResult = await applyMappings(
        dataSource,
        approvedReport.mappings,
        approvedReport.database.beforeFingerprint,
        approvedReport.database.afterFingerprint,
        approvedReport.database.historicalRecomputeFrom,
      );
      outcome = applyResult.status;
      recomputeDebts = applyResult.recomputeDebts;
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    if (globalLock) {
      try {
        await releaseSandreGlobalLock(globalLock);
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      await dataSource.destroy();
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) {
      if (!operationError) {
        throw cleanupError;
      }
      console.error('[sandre-reconcile] cleanup failed', cleanupError);
    }
  }

  const departmentIds = [
    ...new Set(approvedReport.mappings.map((mapping) => mapping.departmentId)),
  ].sort((a, b) => a - b);
  try {
    if (departmentIds.length > 0) {
      await recomputeDepartments(departmentIds);
      await clearRecomputeDebt(recomputeDebts);
    }
  } catch (error) {
    writeApplyOutcome(
      'APPLIED_RECOMPUTE_FAILED',
      outcome,
      approvedReport.mappings,
      error,
    );
    throw error;
  }
  writeApplyOutcome(outcome, outcome, approvedReport.mappings);
}

export async function acquireSandreGlobalLock(
  dataSource: DataSource,
): Promise<QueryRunner> {
  const queryRunner = dataSource.createQueryRunner();
  let connected = false;
  let lockAcquired = false;
  let operationError: unknown;
  try {
    await queryRunner.connect();
    connected = true;
    const [lock] = await queryRunner.query(
      "SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('sandre-zone-sync')) AS locked",
    );
    if (lock?.locked !== true) {
      throw new Error('Another Sandre synchronization is already running');
    }
    lockAcquired = true;
    return queryRunner;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (connected && !lockAcquired) {
      try {
        await queryRunner.release();
      } catch (cleanupError) {
        if (!operationError) {
          throw cleanupError;
        }
      }
    }
  }
}

export async function releaseSandreGlobalLock(
  queryRunner: QueryRunner,
): Promise<void> {
  let cleanupError: unknown;
  try {
    const [unlock] = await queryRunner.query(
      "SELECT pg_advisory_unlock(hashtext('vigieau'), hashtext('sandre-zone-sync')) AS unlocked",
    );
    if (unlock?.unlocked !== true) {
      throw new Error('Unable to release the global Sandre lock');
    }
  } catch (error) {
    cleanupError = error;
    try {
      await queryRunner.query('SELECT pg_advisory_unlock_all()');
    } catch {
      // Releasing a broken connection is the final lock cleanup fallback.
    }
  }
  try {
    await queryRunner.release();
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError) {
    throw cleanupError;
  }
}

async function reportDatabaseStateIsAlreadyApplied(
  dataSource: DataSource,
  report: ReconciliationReport,
): Promise<boolean> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction('REPEATABLE READ');
  try {
    await queryRunner.query('SET TRANSACTION READ ONLY');
    const state = await loadDatabaseState(queryRunner, report.mappings);
    if (fingerprint(state) !== report.database.afterFingerprint) {
      return false;
    }
    await assertNoOldReferences(queryRunner, report.mappings);
    return true;
  } finally {
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }
    await queryRunner.release();
  }
}

async function analyzeReadOnly(
  dataSource: DataSource,
  requestedDepartments: string[],
  databaseMappings?: ReconciliationMapping[],
  manualMappingPairs: ManualMappingPair[] = [],
): Promise<Analysis> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction('REPEATABLE READ');
  try {
    await queryRunner.query('SET TRANSACTION READ ONLY');
    return await analyze(
      queryRunner,
      requestedDepartments,
      databaseMappings,
      manualMappingPairs,
    );
  } finally {
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }
    await queryRunner.release();
  }
}

async function analyze(
  executor: QueryExecutor,
  requestedDepartments: string[],
  databaseMappings?: ReconciliationMapping[],
  manualMappingPairs: ManualMappingPair[] = [],
): Promise<Analysis> {
  const genealogySource = await fetchGenealogySource();
  const departments = await loadDepartments(executor, requestedDepartments);
  const snapshots = await mapWithConcurrency(
    departments,
    4,
    async (department) => ({
      department,
      snapshot: await fetchOfficialSnapshot(department.code),
    }),
  );
  const officialZones: OfficialZoneRecord[] = snapshots.flatMap(
    ({ snapshot }) =>
      snapshot.features.map((feature) => ({
        code: feature.codeSandre,
        gid: feature.gid,
        status: feature.status,
        departmentCode: feature.departmentCode,
        type: feature.type,
        payloadHash: feature.payloadHash,
      })),
  );
  const source: SourceEvidence = {
    ...genealogySource.evidence,
    snapshots: snapshots
      .map(({ department, snapshot }) => ({
        departmentCode: department.code,
        featureCount: snapshot.featureCount,
        snapshotHash: snapshot.snapshotHash,
        sourceUpdatedAt: snapshot.sourceUpdatedAt,
      }))
      .sort((left, right) =>
        left.departmentCode.localeCompare(right.departmentCode),
      ),
    fingerprint: '',
  };
  source.fingerprint = fingerprint({
    metadataUrl: source.metadataUrl,
    metadataSha256: source.metadataSha256,
    csvUrl: source.csvUrl,
    csvSha256: source.csvSha256,
    genealogyRows: source.genealogyRows,
    snapshots: source.snapshots,
  });

  const localZones = await loadLocalZones(
    executor,
    departments.map((department) => department.id),
  );
  const referenceCounts = await loadReferenceCounts(
    executor,
    departments.map((department) => department.id),
  );
  const results = buildReconciliationResults(
    genealogySource.relations,
    officialZones,
    localZones,
    referenceCounts,
  );
  const officialMappings = mappingsFromResults(results, localZones);
  const manualMappings =
    manualMappingPairs.length > 0
      ? await loadStrictManualMappings(
          executor,
          manualMappingPairs,
          departments,
          referenceCounts,
        )
      : null;
  const mappings = manualMappings?.mappings ?? officialMappings;
  const mappingsForDatabaseState = databaseMappings ?? mappings;
  const databaseState = await loadDatabaseState(
    executor,
    mappingsForDatabaseState,
  );
  const collisions = findBlockingCollisions(
    databaseState,
    mappingsForDatabaseState,
  );
  const expectedState = transformDatabaseState(
    databaseState,
    mappingsForDatabaseState,
  );

  return {
    departments,
    source,
    applicationPolicy: manualMappings
      ? 'manual_dry_run_only'
      : 'official_strict_1to1',
    geometryEvidence: manualMappings?.evidence ?? [],
    relations: genealogySource.relations,
    officialZones,
    localZones,
    results,
    mappings,
    databaseState,
    collisions,
    databaseBeforeFingerprint: fingerprint(databaseState),
    databaseAfterFingerprint: fingerprint(expectedState),
    historicalRecomputeFrom: earliestMappedRestrictionDate(
      databaseState,
      mappingsForDatabaseState,
    ),
    candidateFingerprint: fingerprint(reconciliationIdentity(results)),
    mappingFingerprint: fingerprint(mappings),
  };
}

async function fetchOfficialSnapshot(
  departmentCode: string,
): Promise<SandreZoneSnapshot> {
  return fetchSandreZoneSnapshot(
    requiredEnvironmentVariable('API_SANDRE'),
    departmentCode,
    {
      getJson: fetchJson,
      getText: (url) => fetchText(url, false),
    },
  );
}

async function fetchGenealogySource(): Promise<{
  relations: SandreGenealogyRelation[];
  evidence: Omit<SourceEvidence, 'snapshots' | 'fingerprint'>;
}> {
  const metadataUrl =
    process.env.SANDRE_GENEALOGY_METADATA_URL ?? SANDRE_GENEALOGY_METADATA_URL;
  const metadataXml = await fetchText(metadataUrl);
  const csvUrl = discoverGenealogyCsvUrl(metadataXml, metadataUrl);
  const csv = await fetchText(csvUrl);
  const relations = parseGenealogyCsv(csv);

  return {
    relations,
    evidence: {
      metadataUrl,
      metadataSha256: fingerprint(metadataXml),
      csvUrl,
      csvSha256: fingerprint(csv),
      genealogyRows: relations.length,
    },
  };
}

export async function fetchText(
  url: string,
  enforceSizeLimit = true,
): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/xml,text/xml,text/csv,text/html;q=0.9',
      'accept-language': 'fr',
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Unable to fetch ${url}: HTTP ${response.status}`);
  }
  const text = await readResponseText(response, enforceSizeLimit);
  if (!text) {
    throw new Error(`Invalid source size for ${url}`);
  }
  return text;
}

async function readResponseText(
  response: Response,
  enforceSizeLimit: boolean,
): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (enforceSizeLimit && Buffer.byteLength(text, 'utf8') > MAX_SOURCE_SIZE) {
      throw new Error('Source exceeds the configured size limit');
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      byteCount += value.byteLength;
      if (enforceSizeLimit && byteCount > MAX_SOURCE_SIZE) {
        await reader.cancel();
        throw new Error('Source exceeds the configured size limit');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/geo+json,application/json',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Unable to fetch ${url}: HTTP ${response.status}`);
  }
  return response.json();
}

async function recomputeDepartments(departmentIds: number[]): Promise<void> {
  const { runCurrentZoneComputeWorker } =
    await import('../worker_threads/run-current-zone-compute.js');
  const result = await runCurrentZoneComputeWorker(departmentIds);
  if (result?.success !== true) {
    throw new Error(result?.error || 'Zone recomputation did not complete');
  }
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

async function loadDepartments(
  executor: QueryExecutor,
  requestedCodes: string[],
): Promise<DepartmentRow[]> {
  const rows = (await executor.query(
    `
      SELECT id, code
      FROM departement
      WHERE cardinality($1::text[]) = 0 OR code = ANY($1::text[])
      ORDER BY code
    `,
    [requestedCodes],
  )) as DepartmentRow[];
  const foundCodes = new Set(rows.map((row) => row.code));
  const missingCodes = requestedCodes.filter((code) => !foundCodes.has(code));
  if (missingCodes.length > 0) {
    throw new Error(`Unknown department codes: ${missingCodes.join(', ')}`);
  }
  if (rows.length === 0) {
    throw new Error('No department selected');
  }
  return rows;
}

async function loadLocalZones(
  executor: QueryExecutor,
  departmentIds: number[],
): Promise<LocalZoneRecord[]> {
  const rows = await executor.query(
    `
      SELECT
        za.id,
        za."idSandre",
        za."codeSandre",
        za.disabled,
        za."departementId",
        d.code AS "departmentCode",
        za.type,
        za."sandrePayloadHash"
      FROM zone_alerte za
      JOIN departement d ON d.id = za."departementId"
      WHERE za."departementId" = ANY($1::integer[])
      ORDER BY d.code, za.id
    `,
    [departmentIds],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    idSandre: nullableNumber(row.idSandre),
    codeSandre: row.codeSandre ?? null,
    disabled: Boolean(row.disabled),
    departmentId: Number(row.departementId),
    departmentCode: row.departmentCode,
    type: row.type,
    sandrePayloadHash: row.sandrePayloadHash ?? null,
  }));
}

async function loadStrictManualMappings(
  executor: QueryExecutor,
  pairs: ManualMappingPair[],
  departments: DepartmentRow[],
  referenceCounts: Map<number, ZoneReferenceCounts>,
): Promise<{
  mappings: ReconciliationMapping[];
  evidence: ManualMappingEvidence[];
}> {
  const rows = await executor.query(
    `
      WITH requested AS (
        SELECT *
        FROM unnest($1::integer[], $2::integer[])
          AS pair(old_zone_id, new_zone_id)
      ), base AS (
        SELECT
          pair.old_zone_id,
          pair.new_zone_id,
          old_zone.disabled AS old_disabled,
          new_zone.disabled AS new_disabled,
          old_zone.type AS old_type,
          new_zone.type AS new_type,
          old_zone."departementId" AS department_id,
          old_department.code AS department_code,
          new_department.code AS new_department_code,
          COALESCE(old_zone."codeSandre", old_zone."idSandre"::text) AS old_code,
          COALESCE(new_zone."codeSandre", new_zone."idSandre"::text) AS new_code,
          ST_IsValid(old_zone.geom) AND ST_IsValid(new_zone.geom) AS valid,
          ST_Transform(old_zone.geom, 2154) AS old_geom,
          ST_Transform(new_zone.geom, 2154) AS new_geom
        FROM requested pair
        JOIN zone_alerte old_zone ON old_zone.id = pair.old_zone_id
        JOIN zone_alerte new_zone ON new_zone.id = pair.new_zone_id
        JOIN departement old_department
          ON old_department.id = old_zone."departementId"
        JOIN departement new_department
          ON new_department.id = new_zone."departementId"
      ), scored AS (
        SELECT
          base.*,
          intersection.area / NULLIF(ST_Area(base.old_geom), 0) AS source_coverage,
          intersection.area / NULLIF(ST_Area(base.new_geom), 0) AS target_coverage,
          intersection.area / NULLIF(
            ST_Area(base.old_geom) + ST_Area(base.new_geom) - intersection.area,
            0
          ) AS iou
        FROM base
        CROSS JOIN LATERAL (
          SELECT CASE
            WHEN base.valid AND ST_Intersects(base.old_geom, base.new_geom)
              THEN ST_Area(ST_Intersection(base.old_geom, base.new_geom))
            ELSE 0
          END AS area
        ) intersection
      )
      SELECT
        scored.*,
        COALESCE(second_best.iou, 0) AS second_iou,
        COALESCE(second_best.source_coverage, 0) AS second_source_coverage
      FROM scored
      LEFT JOIN LATERAL (
        SELECT
          candidate_intersection.area / NULLIF(
            ST_Area(scored.old_geom) + ST_Area(candidate.geom) -
              candidate_intersection.area,
            0
          ) AS iou,
          candidate_intersection.area / NULLIF(ST_Area(scored.old_geom), 0)
            AS source_coverage
        FROM (
          SELECT
            candidate.id,
            ST_Transform(candidate.geom, 2154) AS geom
          FROM zone_alerte candidate
          WHERE candidate."departementId" = scored.department_id
            AND candidate.type = scored.old_type
            AND candidate.disabled = false
            AND candidate.id <> scored.new_zone_id
            AND ST_IsValid(candidate.geom)
        ) candidate
        CROSS JOIN LATERAL (
          SELECT CASE
            WHEN ST_Intersects(scored.old_geom, candidate.geom)
              THEN ST_Area(ST_Intersection(scored.old_geom, candidate.geom))
            ELSE 0
          END AS area
        ) candidate_intersection
        ORDER BY iou DESC NULLS LAST, candidate.id
        LIMIT 1
      ) second_best ON true
      ORDER BY scored.old_zone_id
    `,
    [pairs.map((pair) => pair.oldZoneId), pairs.map((pair) => pair.newZoneId)],
  );
  if (rows.length !== pairs.length) {
    throw new Error(
      'At least one requested manual mapping zone does not exist',
    );
  }

  const departmentIds = new Set(departments.map((department) => department.id));
  const mappings: ReconciliationMapping[] = [];
  const evidence: ManualMappingEvidence[] = [];
  for (const row of rows) {
    const oldZoneId = Number(row.old_zone_id);
    const newZoneId = Number(row.new_zone_id);
    const geometry: ManualMappingEvidence = {
      oldZoneId,
      newZoneId,
      sourceCoverage: Number(row.source_coverage),
      targetCoverage: Number(row.target_coverage),
      iou: Number(row.iou),
      secondIou: Number(row.second_iou),
      secondSourceCoverage: Number(row.second_source_coverage),
    };
    const references = referenceCounts.get(oldZoneId);
    if (
      oldZoneId === newZoneId ||
      row.old_disabled !== true ||
      row.new_disabled !== false ||
      row.valid !== true ||
      row.old_type !== row.new_type ||
      row.department_code !== row.new_department_code ||
      !departmentIds.has(Number(row.department_id)) ||
      !row.old_code ||
      !row.new_code ||
      !references ||
      references.nonAbrogeArreteCadre < 1 ||
      !isStrictOneToOneGeometry(geometry)
    ) {
      throw new Error(
        `Manual mapping ${oldZoneId}:${newZoneId} does not pass strict 1:1 safeguards`,
      );
    }
    mappings.push({
      departmentId: Number(row.department_id),
      departmentCode: row.department_code,
      zoneType: row.old_type,
      oldZoneId,
      oldCodeSandre: row.old_code,
      newZoneId,
      newCodeSandre: row.new_code,
    });
    evidence.push(geometry);
  }
  return { mappings, evidence };
}

export async function loadReferenceCounts(
  executor: QueryExecutor,
  departmentIds: number[],
): Promise<Map<number, ZoneReferenceCounts>> {
  const [arreteCadreRows, restrictionRows, customizationRows] =
    await Promise.all([
      executor.query(
        `
          SELECT
            az."zoneAlerteId" AS id,
            count(*)::integer AS count
          FROM arrete_cadre_zone_alerte az
          JOIN arrete_cadre ac ON ac.id = az."arreteCadreId"
          JOIN zone_alerte za ON za.id = az."zoneAlerteId"
          WHERE za."departementId" = ANY($1::integer[])
            AND ac.statut IN ('a_venir', 'publie')
          GROUP BY az."zoneAlerteId"
        `,
        [departmentIds],
      ),
      executor.query(
        `
          SELECT r."zoneAlerteId" AS id, count(*)::integer AS count
          FROM restriction r
          JOIN arrete_restriction ar ON ar.id = r."arreteRestrictionId"
          JOIN zone_alerte za ON za.id = r."zoneAlerteId"
          WHERE za."departementId" = ANY($1::integer[])
            AND ar.statut IN ('a_venir', 'publie')
          GROUP BY r."zoneAlerteId"
        `,
        [departmentIds],
      ),
      executor.query(
        `
          SELECT c."zoneAlerteId" AS id, count(*)::integer AS count
          FROM arrete_cadre_zone_alerte_communes c
          JOIN arrete_cadre ac ON ac.id = c."arreteCadreId"
          JOIN zone_alerte za ON za.id = c."zoneAlerteId"
          WHERE za."departementId" = ANY($1::integer[])
            AND ac.statut IN ('a_venir', 'publie')
          GROUP BY c."zoneAlerteId"
        `,
        [departmentIds],
      ),
    ]);
  const counts = new Map<number, ZoneReferenceCounts>();
  const increment = (rows: any[], key: keyof ZoneReferenceCounts): void => {
    rows.forEach((row) => {
      const id = Number(row.id);
      const current = counts.get(id) ?? {
        arreteCadre: 0,
        nonAbrogeArreteCadre: 0,
        restrictions: 0,
        customizations: 0,
      };
      current[key] = Number(row.count);
      counts.set(id, current);
    });
  };
  increment(arreteCadreRows, 'arreteCadre');
  arreteCadreRows.forEach((row) => {
    const current = counts.get(Number(row.id));
    if (current) {
      current.nonAbrogeArreteCadre = Number(row.count);
    }
  });
  increment(restrictionRows, 'restrictions');
  increment(customizationRows, 'customizations');
  return counts;
}

export async function loadDatabaseState(
  executor: QueryExecutor,
  mappings: ReconciliationMapping[],
): Promise<ReconciliationDatabaseState> {
  if (mappings.length === 0) {
    return normalizeDatabaseState({
      zones: [],
      arreteCadreLinks: [],
      restrictions: [],
      customizations: [],
      aliases: [],
    });
  }
  const zoneIds = [
    ...new Set(
      mappings.flatMap((mapping) => [mapping.oldZoneId, mapping.newZoneId]),
    ),
  ].sort((a, b) => a - b);
  const departmentIds = [
    ...new Set(mappings.map((mapping) => mapping.departmentId)),
  ];
  const oldCodes = mappings.map((mapping) => mapping.oldCodeSandre);

  const [zoneRows, linkRows, restrictionRows, customizationRows, aliasRows] =
    await Promise.all([
      executor.query(
        `
          SELECT
            id,
            "idSandre",
            "codeSandre",
            disabled,
            "departementId",
            type,
            "sandrePayloadHash"
          FROM zone_alerte
          WHERE id = ANY($1::integer[])
          ORDER BY id
        `,
        [zoneIds],
      ),
      executor.query(
        `
          SELECT
            link."arreteCadreId",
            ac.statut AS "arreteCadreStatut",
            link."zoneAlerteId"
          FROM arrete_cadre_zone_alerte link
          JOIN arrete_cadre ac ON ac.id = link."arreteCadreId"
          WHERE link."zoneAlerteId" = ANY($1::integer[])
            AND ac.statut IN ('a_venir', 'publie')
          ORDER BY link."arreteCadreId", link."zoneAlerteId"
        `,
        [zoneIds],
      ),
      executor.query(
        `
          SELECT
            restriction_row.id,
            restriction_row."arreteRestrictionId",
            ar.statut AS "arreteRestrictionStatut",
            ar."dateDebut" AS "arreteRestrictionDateDebut",
            restriction_row."zoneAlerteId",
            restriction_row."arreteCadreId",
            restriction_row."nomGroupementAep",
            restriction_row."niveauGravite"
          FROM restriction restriction_row
          JOIN arrete_restriction ar
            ON ar.id = restriction_row."arreteRestrictionId"
          WHERE restriction_row."zoneAlerteId" = ANY($1::integer[])
            AND ar.statut IN ('a_venir', 'publie')
          ORDER BY restriction_row.id
        `,
        [zoneIds],
      ),
      executor.query(
        `
          SELECT
            customization.id,
            customization."arreteCadreId",
            ac.statut AS "arreteCadreStatut",
            customization."zoneAlerteId"
          FROM arrete_cadre_zone_alerte_communes customization
          JOIN arrete_cadre ac ON ac.id = customization."arreteCadreId"
          WHERE customization."zoneAlerteId" = ANY($1::integer[])
            AND ac.statut IN ('a_venir', 'publie')
          ORDER BY customization.id
        `,
        [zoneIds],
      ),
      executor.query(
        `
          SELECT
            "departementId",
            "zoneAlerteId",
            "zoneType",
            "aliasType",
            "aliasValue",
            source
          FROM sandre_zone_alias
          WHERE "departementId" = ANY($1::integer[])
            AND (
              "zoneAlerteId" = ANY($2::integer[])
              OR "aliasValue" = ANY($3::text[])
            )
          ORDER BY "departementId", "zoneType", "aliasType", "aliasValue"
        `,
        [departmentIds, zoneIds, oldCodes],
      ),
    ]);

  // Preserve operational-only fingerprint semantics if these queries are
  // widened later for diagnostics.
  const operationalLinkRows = linkRows.filter((row) =>
    isOperationalParentStatus(row.arreteCadreStatut),
  );
  const operationalRestrictionRows = restrictionRows.filter((row) =>
    isOperationalParentStatus(row.arreteRestrictionStatut),
  );
  const operationalCustomizationRows = customizationRows.filter((row) =>
    isOperationalParentStatus(row.arreteCadreStatut),
  );
  const customizationIds = operationalCustomizationRows.map((row) =>
    Number(row.id),
  );
  const communeRows =
    customizationIds.length === 0
      ? []
      : await executor.query(
          `
            SELECT
              "arreteCadreZoneAlerteCommunesId" AS id,
              "communeId"
            FROM ac_za_communes
            WHERE "arreteCadreZoneAlerteCommunesId" = ANY($1::integer[])
            ORDER BY "arreteCadreZoneAlerteCommunesId", "communeId"
          `,
          [customizationIds],
        );
  const communeIdsByCustomization = new Map<number, number[]>();
  communeRows.forEach((row) => {
    const id = Number(row.id);
    const communeIds = communeIdsByCustomization.get(id) ?? [];
    communeIds.push(Number(row.communeId));
    communeIdsByCustomization.set(id, communeIds);
  });

  return normalizeDatabaseState({
    zones: zoneRows.map((row): DatabaseZoneState => ({
      id: Number(row.id),
      idSandre: nullableNumber(row.idSandre),
      codeSandre: row.codeSandre ?? null,
      disabled: Boolean(row.disabled),
      departmentId: Number(row.departementId),
      type: row.type,
      sandrePayloadHash: row.sandrePayloadHash ?? null,
    })),
    arreteCadreLinks: operationalLinkRows.map(
      (row): DatabaseArreteCadreLink => ({
        arreteCadreId: Number(row.arreteCadreId),
        arreteCadreStatut: row.arreteCadreStatut,
        zoneAlerteId: Number(row.zoneAlerteId),
      }),
    ),
    restrictions: operationalRestrictionRows.map(
      (row): DatabaseRestrictionState => ({
        id: Number(row.id),
        arreteRestrictionId: Number(row.arreteRestrictionId),
        arreteRestrictionDateDebut: row.arreteRestrictionDateDebut ?? null,
        zoneAlerteId: Number(row.zoneAlerteId),
        arreteCadreId: nullableNumber(row.arreteCadreId),
        nomGroupementAep: row.nomGroupementAep ?? null,
        niveauGravite: row.niveauGravite ?? null,
      }),
    ),
    customizations: operationalCustomizationRows.map(
      (row): DatabaseCustomizationState => ({
        id: Number(row.id),
        arreteCadreId: Number(row.arreteCadreId),
        zoneAlerteId: Number(row.zoneAlerteId),
        communeIds: communeIdsByCustomization.get(Number(row.id)) ?? [],
      }),
    ),
    aliases: aliasRows.map((row): DatabaseAliasState => ({
      departmentId: Number(row.departementId),
      zoneAlerteId: Number(row.zoneAlerteId),
      zoneType: row.zoneType,
      aliasType: row.aliasType,
      aliasValue: row.aliasValue,
      source: row.source,
    })),
  });
}

function createReport(analysis: Analysis): ReconciliationReport {
  const reportWithoutFingerprint = {
    version: RECONCILIATION_REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    scope: {
      departments: analysis.departments
        .map((department) => department.code)
        .sort(),
    },
    source: analysis.source,
    applicationPolicy: analysis.applicationPolicy,
    geometryEvidence: analysis.geometryEvidence,
    candidateFingerprint: analysis.candidateFingerprint,
    mappingFingerprint: analysis.mappingFingerprint,
    database: {
      beforeFingerprint: analysis.databaseBeforeFingerprint,
      afterFingerprint: analysis.databaseAfterFingerprint,
      historicalRecomputeFrom: analysis.historicalRecomputeFrom,
    },
    targetFingerprint: currentTargetFingerprint(),
    summary: {
      applicable: analysis.results.filter(
        (item) => item.status === 'APPLICABLE',
      ).length,
      ambiguous: analysis.results.filter((item) => item.status === 'AMBIGUOUS')
        .length,
      noOfficialSuccessor: analysis.results.filter(
        (item) => item.status === 'NO_OFFICIAL_SUCCESSOR',
      ).length,
      blockingCollisions: analysis.collisions.length,
      selectedMappings: analysis.mappings.length,
    },
    results: analysis.results,
    mappings: analysis.mappings,
    collisions: analysis.collisions,
  };
  return {
    ...reportWithoutFingerprint,
    reportFingerprint: fingerprint(reportWithoutFingerprint),
  };
}

async function recordReconciliationDecisions(
  dataSource: DataSource,
  report: ReconciliationReport,
): Promise<void> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction('SERIALIZABLE');
  try {
    const [batch] = await queryRunner.query(
      `
        INSERT INTO sandre_zone_sync_batch (
          kind, mode, status, "reportFingerprint", metadata,
          "startedAt", "finishedAt"
        ) VALUES (
          'reconciliation', 'audit', 'observed', $1, $2::jsonb,
          clock_timestamp(), clock_timestamp()
        )
        RETURNING id
      `,
      [
        report.reportFingerprint,
        JSON.stringify({
          applicationPolicy: report.applicationPolicy,
          mappingFingerprint: report.mappingFingerprint,
          sourceFingerprint: report.source.fingerprint,
          strictGeometryThresholds: STRICT_GEOMETRY_THRESHOLDS,
        }),
      ],
    );
    const evidenceByMapping = new Map(
      report.geometryEvidence.map((item) => [
        `${item.oldZoneId}:${item.newZoneId}`,
        item,
      ]),
    );
    for (const mapping of report.mappings) {
      await queryRunner.query(
        `
          INSERT INTO sandre_zone_sync_decision (
            "batchId", "departementId", "zoneAlerteId",
            "candidateZoneAlerteId", "decisionKey", "zoneType",
            "sourceCode", "targetCode", action, outcome, reason, evidence
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            'RECONCILE_1_TO_1', 'deferred', $9, $10::jsonb
          )
        `,
        [
          batch.id,
          mapping.departmentId,
          mapping.oldZoneId,
          mapping.newZoneId,
          `${mapping.oldZoneId}:${mapping.newZoneId}`,
          mapping.zoneType,
          mapping.oldCodeSandre,
          mapping.newCodeSandre,
          report.applicationPolicy === 'manual_dry_run_only'
            ? 'MANUAL_GEOMETRY_DRY_RUN'
            : 'OFFICIAL_LINEAR_SUCCESSOR_DRY_RUN',
          JSON.stringify(
            evidenceByMapping.get(
              `${mapping.oldZoneId}:${mapping.newZoneId}`,
            ) ?? null,
          ),
        ],
      );
    }
    await queryRunner.commitTransaction();
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }
}

async function writeReportFile(path: string, content: string): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await pipeline(
      Readable.from([content]),
      handle.createWriteStream({ autoClose: false }),
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readApprovedReport(
  reportPath: string | null,
): Promise<ReconciliationReport> {
  if (!reportPath) {
    throw new Error('--apply requires --report <path>');
  }
  const report = JSON.parse(
    await readFile(resolve(reportPath), 'utf8'),
  ) as ReconciliationReport;
  if (report.version !== RECONCILIATION_REPORT_VERSION) {
    throw new Error(`Unsupported report version ${report.version}`);
  }
  const { reportFingerprint, ...unsignedReport } = report;
  if (fingerprint(unsignedReport) !== reportFingerprint) {
    throw new Error('The approved report fingerprint is invalid');
  }
  if (fingerprint(report.mappings) !== report.mappingFingerprint) {
    throw new Error('The approved report mappings are invalid');
  }
  return report;
}

function assertAnalysisMatchesReport(
  analysis: Analysis,
  report: ReconciliationReport,
): void {
  const currentDepartments = analysis.departments
    .map((department) => department.code)
    .sort();
  if (
    fingerprint(currentDepartments) !== fingerprint(report.scope.departments)
  ) {
    throw new Error('Department scope changed since the approved report');
  }
  if (
    analysis.applicationPolicy !== report.applicationPolicy ||
    fingerprint(analysis.geometryEvidence) !==
      fingerprint(report.geometryEvidence)
  ) {
    throw new Error('Reconciliation application policy changed');
  }
  if (analysis.source.fingerprint !== report.source.fingerprint) {
    throw new Error('Sandre source changed since the approved report');
  }
  const currentDatabaseFingerprint = analysis.databaseBeforeFingerprint;
  if (currentDatabaseFingerprint === report.database.afterFingerprint) {
    return;
  }
  if (currentDatabaseFingerprint !== report.database.beforeFingerprint) {
    throw new Error('Database state changed since the approved report');
  }
  if (analysis.candidateFingerprint !== report.candidateFingerprint) {
    throw new Error(
      'Reconciliation candidates changed since the approved report',
    );
  }
  if (analysis.mappingFingerprint !== report.mappingFingerprint) {
    throw new Error(
      'Reconciliation mappings changed since the approved report',
    );
  }
  if (fingerprint(analysis.collisions) !== fingerprint(report.collisions)) {
    throw new Error('Blocking collisions changed since the approved report');
  }
  if (analysis.databaseAfterFingerprint !== report.database.afterFingerprint) {
    throw new Error(
      'Expected database state changed since the approved report',
    );
  }
  if (
    analysis.historicalRecomputeFrom !== report.database.historicalRecomputeFrom
  ) {
    throw new Error(
      'Historical recomputation scope changed since the approved report',
    );
  }
}

async function applyMappings(
  dataSource: DataSource,
  mappings: ReconciliationMapping[],
  approvedBeforeFingerprint: string,
  approvedAfterFingerprint: string,
  historicalRecomputeFrom: string | null,
): Promise<ApplyMappingsResult> {
  if (mappings.length === 0) {
    return { status: 'ALREADY_APPLIED', recomputeDebts: [] };
  }

  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  let historicalLockAcquired = false;
  let transactionStarted = false;
  let operationError: unknown;

  try {
    historicalLockAcquired = await acquireHistoricalRecomputeLock(
      queryRunner,
      historicalRecomputeFrom,
    );
    await queryRunner.startTransaction('SERIALIZABLE');
    transactionStarted = true;

    const departmentIds = [
      ...new Set(mappings.map((mapping) => mapping.departmentId)),
    ].sort((a, b) => a - b);
    for (const departmentId of departmentIds) {
      await queryRunner.query(
        "SELECT pg_advisory_xact_lock(hashtext('vigieau:sandre-zone-sync'), $1)",
        [departmentId],
      );
    }

    const zoneIds = [
      ...new Set(
        mappings.flatMap((mapping) => [mapping.oldZoneId, mapping.newZoneId]),
      ),
    ].sort((a, b) => a - b);
    await lockAffectedRows(queryRunner, zoneIds);

    const lockedState = await loadDatabaseState(queryRunner, mappings);
    const lockedFingerprint = fingerprint(lockedState);
    if (lockedFingerprint === approvedAfterFingerprint) {
      await assertNoOldReferences(queryRunner, mappings);
      await markHistoricalRecomputeDebt(queryRunner, historicalRecomputeFrom);
      const recomputeDebts = await markRecomputeDebt(
        queryRunner,
        departmentIds,
      );
      await queryRunner.commitTransaction();
      transactionStarted = false;
      return { status: 'ALREADY_APPLIED', recomputeDebts };
    }
    if (lockedFingerprint !== approvedBeforeFingerprint) {
      throw new Error('Locked database state differs from the approved report');
    }

    const collisions = findBlockingCollisions(lockedState, mappings);
    if (collisions.length > 0) {
      throw new Error(
        `Apply blocked by ${collisions.length} relation collision(s)`,
      );
    }

    await createMappingTable(queryRunner, mappings);
    await moveOperationalReferences(queryRunner);
    await queryRunner.query(`
      UPDATE sandre_zone_alias alias
      SET "zoneAlerteId" = mapping.new_zone_id
      FROM sandre_reconciliation_mapping mapping
      WHERE alias."zoneAlerteId" = mapping.old_zone_id
    `);
    await queryRunner.query(`
      INSERT INTO sandre_zone_alias (
        "departementId",
        "zoneAlerteId",
        "zoneType",
        "aliasType",
        "aliasValue",
        source
      )
      SELECT
        mapping.department_id,
        mapping.new_zone_id,
        mapping.zone_type,
        'cd_zas',
        mapping.old_code_sandre,
        'manual_reconciliation'
      FROM sandre_reconciliation_mapping mapping
      ON CONFLICT (
        "departementId",
        "zoneType",
        "aliasType",
        "aliasValue"
      ) DO NOTHING
    `);

    await assertNoOldReferences(queryRunner, mappings);
    const finalState = await loadDatabaseState(queryRunner, mappings);
    if (fingerprint(finalState) !== approvedAfterFingerprint) {
      throw new Error('Final database state differs from the approved result');
    }

    await markHistoricalRecomputeDebt(queryRunner, historicalRecomputeFrom);
    const recomputeDebts = await markRecomputeDebt(queryRunner, departmentIds);
    await queryRunner.commitTransaction();
    transactionStarted = false;
    return { status: 'APPLIED', recomputeDebts };
  } catch (error) {
    operationError = error;
    if (transactionStarted) {
      await queryRunner.rollbackTransaction();
      transactionStarted = false;
    }
    throw error;
  } finally {
    try {
      await releaseReconciliationResources(queryRunner, historicalLockAcquired);
    } catch (cleanupError) {
      if (!operationError) {
        throw cleanupError;
      }
    }
  }
}

async function recordRecomputeDebt(
  dataSource: DataSource,
  mappings: ReconciliationMapping[],
  historicalRecomputeFrom: string | null,
): Promise<RecomputeDebt[]> {
  const departmentIds = [
    ...new Set(mappings.map((mapping) => mapping.departmentId)),
  ].sort((a, b) => a - b);
  if (departmentIds.length === 0) {
    return [];
  }

  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  let historicalLockAcquired = false;
  let transactionStarted = false;
  let operationError: unknown;

  try {
    historicalLockAcquired = await acquireHistoricalRecomputeLock(
      queryRunner,
      historicalRecomputeFrom,
    );
    await queryRunner.startTransaction('SERIALIZABLE');
    transactionStarted = true;

    for (const departmentId of departmentIds) {
      await queryRunner.query(
        "SELECT pg_advisory_xact_lock(hashtext('vigieau:sandre-zone-sync'), $1)",
        [departmentId],
      );
    }
    await markHistoricalRecomputeDebt(queryRunner, historicalRecomputeFrom);
    const recomputeDebts = await markRecomputeDebt(queryRunner, departmentIds);
    await queryRunner.commitTransaction();
    transactionStarted = false;
    return recomputeDebts;
  } catch (error) {
    operationError = error;
    if (transactionStarted) {
      await queryRunner.rollbackTransaction();
      transactionStarted = false;
    }
    throw error;
  } finally {
    try {
      await releaseReconciliationResources(queryRunner, historicalLockAcquired);
    } catch (cleanupError) {
      if (!operationError) {
        throw cleanupError;
      }
    }
  }
}

export async function prepareSandreOperationRecomputeDebt(
  executor: QueryExecutor,
  status: 'APPLIED' | 'ALREADY_APPLIED',
  departmentIds: number[],
  historicalRecomputeFrom: string | null,
): Promise<RecomputeDebt[]> {
  if (status === 'ALREADY_APPLIED') {
    return loadPendingRecomputeDebt(executor, departmentIds);
  }
  await markHistoricalRecomputeDebt(executor, historicalRecomputeFrom);
  return markRecomputeDebt(executor, departmentIds);
}

async function loadPendingRecomputeDebt(
  executor: QueryExecutor,
  departmentIds: number[],
): Promise<RecomputeDebt[]> {
  if (departmentIds.length === 0) {
    return [];
  }
  const rows = await executor.query(
    `
      SELECT "departementId", "recomputeRevision"
      FROM sandre_zone_sync_state
      WHERE "departementId" = ANY($1::integer[])
        AND "needsRecompute" = true
      ORDER BY "departementId"
    `,
    [departmentIds],
  );
  return rows.map((row) => ({
    departmentId: Number(row.departementId),
    revision: Number(row.recomputeRevision),
  }));
}

async function markRecomputeDebt(
  executor: QueryExecutor,
  departmentIds: number[],
): Promise<RecomputeDebt[]> {
  if (departmentIds.length === 0) {
    return [];
  }
  const rows = await executor.query(
    `
      INSERT INTO sandre_zone_sync_state (
        "departementId",
        "needsRecompute",
        "recomputeRevision"
      )
      SELECT department_id, true, 1
      FROM unnest($1::integer[]) AS departments(department_id)
      ON CONFLICT ("departementId") DO UPDATE
      SET
        "needsRecompute" = true,
        "recomputeRevision" =
          sandre_zone_sync_state."recomputeRevision" + 1,
        "updatedAt" = now()
      RETURNING
        "departementId",
        "recomputeRevision"
    `,
    [departmentIds],
  );
  return rows
    .map((row) => ({
      departmentId: Number(row.departementId),
      revision: Number(row.recomputeRevision),
    }))
    .sort((left, right) => left.departmentId - right.departmentId);
}

async function clearRecomputeDebt(debts: RecomputeDebt[]): Promise<void> {
  if (debts.length === 0) {
    return;
  }
  const dataSource = createStandaloneDataSource();
  await dataSource.initialize();
  try {
    await clearSandreOperationRecomputeDebt(dataSource, debts);
  } finally {
    await dataSource.destroy();
  }
}

export async function clearSandreOperationRecomputeDebt(
  executor: QueryExecutor,
  debts: RecomputeDebt[],
): Promise<void> {
  if (debts.length === 0) {
    return;
  }
  await executor.query(
    `
      UPDATE sandre_zone_sync_state state
      SET "needsRecompute" = false, "updatedAt" = now()
      FROM unnest(
        $1::integer[],
        $2::integer[]
      ) AS debt(department_id, revision)
      WHERE state."departementId" = debt.department_id
        AND state."recomputeRevision" = debt.revision
        AND state."needsRecompute" = true
    `,
    [
      debts.map((debt) => debt.departmentId),
      debts.map((debt) => debt.revision),
    ],
  );
}

async function markHistoricalRecomputeDebt(
  executor: QueryExecutor,
  date: string | null,
): Promise<void> {
  if (!date) {
    return;
  }
  await executor.query(
    `
      INSERT INTO config (
        id,
        "computeMapDate",
        "computeStatsDate"
      )
      VALUES (1, $1::date, $1::date)
      ON CONFLICT (id) DO UPDATE
      SET
        "computeMapDate" = CASE
          WHEN config."computeMapDate" IS NULL
            OR config."computeMapDate" > EXCLUDED."computeMapDate"
          THEN EXCLUDED."computeMapDate"
          ELSE config."computeMapDate"
        END,
        "computeStatsDate" = CASE
          WHEN config."computeStatsDate" IS NULL
            OR config."computeStatsDate" > EXCLUDED."computeStatsDate"
          THEN EXCLUDED."computeStatsDate"
          ELSE config."computeStatsDate"
        END
    `,
    [date],
  );
}

export async function acquireHistoricalRecomputeLock(
  executor: QueryExecutor,
  historicalRecomputeFrom: string | null,
  timeoutMs = HISTORICAL_RECOMPUTE_LOCK_TIMEOUT_MS,
): Promise<boolean> {
  if (!historicalRecomputeFrom) {
    return false;
  }

  const deadline = Date.now() + timeoutMs;
  while (true) {
    const [lockResult] = await executor.query(
      "SELECT pg_try_advisory_lock(hashtext('vigieau'), hashtext('zone-compute-historic')) AS locked",
    );
    if (lockResult?.locked === true) {
      return true;
    }
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the historic zone compute lock');
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function releaseHistoricalRecomputeLock(
  executor: QueryExecutor,
): Promise<void> {
  let unlockResult: { unlocked?: boolean } | undefined;
  try {
    [unlockResult] = await executor.query(
      "SELECT pg_advisory_unlock(hashtext('vigieau'), hashtext('zone-compute-historic')) AS unlocked",
    );
  } catch (error) {
    try {
      await executor.query('SELECT pg_advisory_unlock_all()');
    } catch {
      // Releasing the query runner is the final cleanup fallback.
    }
    throw error;
  }
  if (unlockResult?.unlocked !== true) {
    throw new Error('Unable to release the historic zone compute lock');
  }
}

export async function releaseReconciliationResources(
  queryRunner: QueryRunner,
  historicalLockAcquired: boolean,
): Promise<void> {
  let cleanupError: unknown;
  if (historicalLockAcquired) {
    try {
      await releaseHistoricalRecomputeLock(queryRunner);
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    await queryRunner.release();
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError) {
    throw cleanupError;
  }
}

export async function moveOperationalReferences(
  executor: QueryExecutor,
): Promise<void> {
  await executor.query(`
    INSERT INTO arrete_cadre_zone_alerte ("arreteCadreId", "zoneAlerteId")
    SELECT link."arreteCadreId", mapping.new_zone_id
    FROM arrete_cadre_zone_alerte link
    JOIN arrete_cadre parent ON parent.id = link."arreteCadreId"
    JOIN sandre_reconciliation_mapping mapping
      ON mapping.old_zone_id = link."zoneAlerteId"
    WHERE parent.statut IN ('a_venir', 'publie')
    ON CONFLICT DO NOTHING
  `);
  await executor.query(`
    DELETE FROM arrete_cadre_zone_alerte link
    USING sandre_reconciliation_mapping mapping, arrete_cadre parent
    WHERE link."arreteCadreId" = parent.id
      AND link."zoneAlerteId" = mapping.old_zone_id
      AND parent.statut IN ('a_venir', 'publie')
  `);
  await executor.query(`
    UPDATE restriction reference
    SET "zoneAlerteId" = mapping.new_zone_id
    FROM sandre_reconciliation_mapping mapping, arrete_restriction parent
    WHERE reference."arreteRestrictionId" = parent.id
      AND reference."zoneAlerteId" = mapping.old_zone_id
      AND parent.statut IN ('a_venir', 'publie')
  `);
  await executor.query(`
    UPDATE arrete_cadre_zone_alerte_communes reference
    SET "zoneAlerteId" = mapping.new_zone_id
    FROM sandre_reconciliation_mapping mapping, arrete_cadre parent
    WHERE reference."arreteCadreId" = parent.id
      AND reference."zoneAlerteId" = mapping.old_zone_id
      AND parent.statut IN ('a_venir', 'publie')
  `);
}

export async function lockAffectedRows(
  queryRunner: QueryRunner,
  zoneIds: number[],
): Promise<void> {
  await queryRunner.query(
    `
      SELECT id
      FROM zone_alerte
      WHERE id = ANY($1::integer[])
      ORDER BY id
      FOR UPDATE
    `,
    [zoneIds],
  );
  await queryRunner.query(
    `
      SELECT parent.id
      FROM arrete_cadre parent
      WHERE parent.id IN (
        SELECT link."arreteCadreId"
        FROM arrete_cadre_zone_alerte link
        WHERE link."zoneAlerteId" = ANY($1::integer[])
        UNION
        SELECT reference."arreteCadreId"
        FROM arrete_cadre_zone_alerte_communes reference
        WHERE reference."zoneAlerteId" = ANY($1::integer[])
      )
      ORDER BY parent.id
      FOR UPDATE
    `,
    [zoneIds],
  );
  await queryRunner.query(
    `
      SELECT parent.id
      FROM arrete_restriction parent
      WHERE parent.id IN (
        SELECT reference."arreteRestrictionId"
        FROM restriction reference
        WHERE reference."zoneAlerteId" = ANY($1::integer[])
      )
      ORDER BY parent.id
      FOR UPDATE
    `,
    [zoneIds],
  );
  await queryRunner.query(
    `
      SELECT reference.id
      FROM restriction reference
      JOIN arrete_restriction parent
        ON parent.id = reference."arreteRestrictionId"
      WHERE reference."zoneAlerteId" = ANY($1::integer[])
        AND parent.statut IN ('a_venir', 'publie')
      ORDER BY reference.id
      FOR UPDATE OF reference
    `,
    [zoneIds],
  );
  await queryRunner.query(
    `
      SELECT reference.id
      FROM arrete_cadre_zone_alerte_communes reference
      JOIN arrete_cadre parent ON parent.id = reference."arreteCadreId"
      WHERE reference."zoneAlerteId" = ANY($1::integer[])
        AND parent.statut IN ('a_venir', 'publie')
      ORDER BY reference.id
      FOR UPDATE OF reference
    `,
    [zoneIds],
  );
  await queryRunner.query(
    `
      SELECT link."arreteCadreId", link."zoneAlerteId"
      FROM arrete_cadre_zone_alerte link
      JOIN arrete_cadre parent ON parent.id = link."arreteCadreId"
      WHERE link."zoneAlerteId" = ANY($1::integer[])
        AND parent.statut IN ('a_venir', 'publie')
      ORDER BY link."arreteCadreId", link."zoneAlerteId"
      FOR UPDATE OF link
    `,
    [zoneIds],
  );
  await queryRunner.query(
    `
      SELECT id
      FROM sandre_zone_alias
      WHERE "zoneAlerteId" = ANY($1::integer[])
      ORDER BY id
      FOR UPDATE
    `,
    [zoneIds],
  );
}

async function createMappingTable(
  queryRunner: QueryRunner,
  mappings: ReconciliationMapping[],
): Promise<void> {
  await queryRunner.query(`
    CREATE TEMPORARY TABLE sandre_reconciliation_mapping (
      old_zone_id integer PRIMARY KEY,
      new_zone_id integer UNIQUE NOT NULL,
      department_id integer NOT NULL,
      department_code text NOT NULL,
      zone_type text NOT NULL,
      old_code_sandre text NOT NULL,
      new_code_sandre text NOT NULL,
      CHECK (old_zone_id <> new_zone_id)
    ) ON COMMIT DROP
  `);
  await queryRunner.query(
    `
      INSERT INTO sandre_reconciliation_mapping (
        old_zone_id,
        new_zone_id,
        department_id,
        department_code,
        zone_type,
        old_code_sandre,
        new_code_sandre
      )
      SELECT *
      FROM unnest(
        $1::integer[],
        $2::integer[],
        $3::integer[],
        $4::text[],
        $5::text[],
        $6::text[],
        $7::text[]
      )
    `,
    [
      mappings.map((mapping) => mapping.oldZoneId),
      mappings.map((mapping) => mapping.newZoneId),
      mappings.map((mapping) => mapping.departmentId),
      mappings.map((mapping) => mapping.departmentCode),
      mappings.map((mapping) => mapping.zoneType),
      mappings.map((mapping) => mapping.oldCodeSandre),
      mappings.map((mapping) => mapping.newCodeSandre),
    ],
  );
}

export async function assertNoOldReferences(
  executor: QueryExecutor,
  mappings: ReconciliationMapping[],
): Promise<void> {
  const oldZoneIds = mappings.map((mapping) => mapping.oldZoneId);
  const rows = await executor.query(
    `
      SELECT old_zone_id
      FROM unnest($1::integer[]) AS mapping(old_zone_id)
      WHERE EXISTS (
        SELECT 1
        FROM arrete_cadre_zone_alerte reference
        JOIN arrete_cadre parent ON parent.id = reference."arreteCadreId"
        WHERE reference."zoneAlerteId" = mapping.old_zone_id
          AND parent.statut IN ('a_venir', 'publie')
      )
      OR EXISTS (
        SELECT 1
        FROM restriction reference
        JOIN arrete_restriction parent
          ON parent.id = reference."arreteRestrictionId"
        WHERE reference."zoneAlerteId" = mapping.old_zone_id
          AND parent.statut IN ('a_venir', 'publie')
      )
      OR EXISTS (
        SELECT 1
        FROM arrete_cadre_zone_alerte_communes reference
        JOIN arrete_cadre parent ON parent.id = reference."arreteCadreId"
        WHERE reference."zoneAlerteId" = mapping.old_zone_id
          AND parent.statut IN ('a_venir', 'publie')
      )
      OR EXISTS (
        SELECT 1
        FROM sandre_zone_alias
        WHERE "zoneAlerteId" = mapping.old_zone_id
      )
    `,
    [oldZoneIds],
  );
  if (rows.length > 0) {
    throw new Error(
      `Old zones still referenced: ${rows
        .map((row) => row.old_zone_id)
        .join(', ')}`,
    );
  }
}

export function parseCliOptions(args: string[]): CliOptions {
  const departments = new Set<string>();
  const mappingPairs = new Map<number, number>();
  let apply = false;
  let dryRun = false;
  let recordDecisions = false;
  let verifyPostSafe = false;
  let reportPath: string | null = null;
  let operationPlanPath: string | null = null;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (argument === '--record-decisions') {
      recordDecisions = true;
      continue;
    }
    if (argument === '--verify-post-safe') {
      verifyPostSafe = true;
      continue;
    }
    if (
      argument === '--department' ||
      argument === '--report' ||
      argument === '--mapping' ||
      argument === '--plan'
    ) {
      const value = args[++index];
      if (!value) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === '--department') {
        value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
          .forEach((item) => departments.add(item));
      } else if (argument === '--report') {
        reportPath = value;
      } else if (argument === '--plan') {
        operationPlanPath = value;
      } else {
        addManualMappingPairs(mappingPairs, value);
      }
      continue;
    }
    if (argument.startsWith('--department=')) {
      argument
        .slice('--department='.length)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .forEach((item) => departments.add(item));
      continue;
    }
    if (argument.startsWith('--report=')) {
      reportPath = argument.slice('--report='.length);
      continue;
    }
    if (argument.startsWith('--plan=')) {
      operationPlanPath = argument.slice('--plan='.length);
      continue;
    }
    if (argument.startsWith('--mapping=')) {
      addManualMappingPairs(mappingPairs, argument.slice('--mapping='.length));
      continue;
    }
    if (argument === '--help') {
      process.stdout.write(
        [
          'Usage: npm run zones:sandre:reconcile -- [options]',
          '',
          'Dry-run is the default and writes JSON to stdout.',
          '  --department CODE[,CODE]  Limit the audit to departments',
          '  --report PATH             Write a new dry-run report or read it for apply',
          '  --mapping OLD:NEW[,..]    Audit explicit strict 1:1 mappings; never applicable',
          '  --plan PATH               Audit a versioned reconciliation operation plan',
          '  --record-decisions        Persist the dry-run batch and decisions',
          '  --apply                   Apply an unchanged approved report',
          '  --verify-post-safe        Verify safe convergence from an approved report',
          '',
        ].join('\n'),
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  const sortedDepartments = [...departments].sort();
  if (apply && dryRun) {
    throw new Error('--apply and --dry-run are mutually exclusive');
  }
  if (verifyPostSafe && (apply || dryRun)) {
    throw new Error(
      '--verify-post-safe cannot be combined with --apply or --dry-run',
    );
  }
  if (apply && !reportPath) {
    throw new Error('--apply requires --report <path>');
  }
  if (verifyPostSafe && !reportPath) {
    throw new Error('--verify-post-safe requires --report <path>');
  }
  if (apply && (mappingPairs.size > 0 || recordDecisions)) {
    throw new Error(
      '--mapping and --record-decisions are dry-run options only',
    );
  }
  if (apply && operationPlanPath) {
    throw new Error(
      '--apply reads its operation plan from the approved report',
    );
  }
  if (
    verifyPostSafe &&
    (operationPlanPath ||
      mappingPairs.size > 0 ||
      sortedDepartments.length > 0 ||
      recordDecisions)
  ) {
    throw new Error('--verify-post-safe accepts only an approved --report');
  }
  if (
    operationPlanPath &&
    (mappingPairs.size > 0 || sortedDepartments.length > 0 || recordDecisions)
  ) {
    throw new Error(
      '--plan cannot be combined with --department, --mapping or --record-decisions',
    );
  }
  if (mappingPairs.size > 0 && sortedDepartments.length === 0) {
    throw new Error('--mapping requires an explicit --department scope');
  }
  return {
    apply,
    departments: sortedDepartments,
    mappingPairs: [...mappingPairs.entries()]
      .map(([oldZoneId, newZoneId]) => ({ oldZoneId, newZoneId }))
      .sort((left, right) => left.oldZoneId - right.oldZoneId),
    operationPlanPath,
    recordDecisions,
    reportPath,
    verifyPostSafe,
  };
}

function addManualMappingPairs(
  mappings: Map<number, number>,
  value: string,
): void {
  const usedTargets = new Set(mappings.values());
  for (const item of value.split(',').map((part) => part.trim())) {
    const match = item.match(/^(\d+):(\d+)$/);
    if (!match) {
      throw new Error(`Invalid --mapping value: ${item}`);
    }
    const oldZoneId = Number(match[1]);
    const newZoneId = Number(match[2]);
    if (
      oldZoneId <= 0 ||
      newZoneId <= 0 ||
      oldZoneId === newZoneId ||
      mappings.has(oldZoneId) ||
      usedTargets.has(newZoneId)
    ) {
      throw new Error(`Mapping ${item} is not one-to-one`);
    }
    mappings.set(oldZoneId, newZoneId);
    usedTargets.add(newZoneId);
  }
}

async function mapWithConcurrency<T, U>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= values.length) {
          return;
        }
        results[index] = await mapper(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function isOperationalParentStatus(value: unknown): boolean {
  return value === 'a_venir' || value === 'publie';
}

function writeApplyOutcome(
  status: 'APPLIED' | 'ALREADY_APPLIED' | 'APPLIED_RECOMPUTE_FAILED',
  databaseStatus: 'APPLIED' | 'ALREADY_APPLIED',
  mappings: ReconciliationMapping[],
  error?: unknown,
): void {
  process.stdout.write(
    `${JSON.stringify(
      {
        status,
        databaseStatus,
        mappings: mappings.length,
        recomputedDepartments: [
          ...new Set(mappings.map((mapping) => mapping.departmentCode)),
        ].sort(),
        ...(error
          ? {
              recomputeError:
                error instanceof Error ? error.message : String(error),
            }
          : {}),
      },
      null,
      2,
    )}\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[sandre-reconcile] failed');
    console.error(error);
    process.exitCode = 1;
  });
}
