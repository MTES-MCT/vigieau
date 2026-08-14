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
  STRICT_GEOMETRY_THRESHOLDS,
  StrictGeometryEvidence,
} from '../zone_alerte/sandre-zone-governance';

export const RECONCILIATION_REPORT_VERSION = 5;
const MAX_SOURCE_SIZE = 10 * 1024 * 1024;
const HISTORICAL_RECOMPUTE_LOCK_TIMEOUT_MS = 60 * 60 * 1000;

export interface CliOptions {
  apply: boolean;
  departments: string[];
  mappingPairs: ManualMappingPair[];
  recordDecisions: boolean;
  reportPath: string | null;
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

interface RecomputeDebt {
  departmentId: number;
  revision: number;
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

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
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
    zones: zoneRows.map(
      (row): DatabaseZoneState => ({
        id: Number(row.id),
        idSandre: nullableNumber(row.idSandre),
        codeSandre: row.codeSandre ?? null,
        disabled: Boolean(row.disabled),
        departmentId: Number(row.departementId),
        type: row.type,
        sandrePayloadHash: row.sandrePayloadHash ?? null,
      }),
    ),
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
    aliases: aliasRows.map(
      (row): DatabaseAliasState => ({
        departmentId: Number(row.departementId),
        zoneAlerteId: Number(row.zoneAlerteId),
        zoneType: row.zoneType,
        aliasType: row.aliasType,
        aliasValue: row.aliasValue,
        source: row.source,
      }),
    ),
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
    await dataSource.query(
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
  } finally {
    await dataSource.destroy();
  }
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
  let reportPath: string | null = null;

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
    if (
      argument === '--department' ||
      argument === '--report' ||
      argument === '--mapping'
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
          '  --record-decisions        Persist the dry-run batch and decisions',
          '  --apply                   Apply an unchanged approved report',
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
  if (apply && !reportPath) {
    throw new Error('--apply requires --report <path>');
  }
  if (apply && (mappingPairs.size > 0 || recordDecisions)) {
    throw new Error(
      '--mapping and --record-decisions are dry-run options only',
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
    recordDecisions,
    reportPath,
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
