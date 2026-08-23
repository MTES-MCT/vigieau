import {
  isStrictOneToOneGeometry,
  STRICT_GEOMETRY_THRESHOLDS,
} from './sandre-zone-governance';
import { fingerprint } from './sandre-zone-reconciliation';
import {
  normalizeSandreZoneGeometries,
  SandreGeometryAudit,
} from './sandre-zone-geometry';

export type SandreReconciliationStrategy =
  | 'replace_1to1'
  | 'replace_partition_1ton'
  | 'preserve_local'
  | 'canonicalize_duplicate';

interface SandreReconciliationActionBase {
  strategy: SandreReconciliationStrategy;
  departmentCode: string;
  zoneType: 'SOU' | 'SUP';
  sourceZoneId: number;
  expectedSourceCode?: string;
}

export interface ReplaceOneToOneAction extends SandreReconciliationActionBase {
  strategy: 'replace_1to1';
  targetZoneId: number;
}

export interface ReplacePartitionAction extends SandreReconciliationActionBase {
  strategy: 'replace_partition_1ton';
  targetZoneIds: number[];
}

export interface PreserveLocalAction extends SandreReconciliationActionBase {
  strategy: 'preserve_local';
}

export interface CanonicalizeDuplicateAction extends SandreReconciliationActionBase {
  strategy: 'canonicalize_duplicate';
  targetZoneId: number;
  expectedSandreGid: number;
  officialCode: string;
  requiredSourceBusinessReferenceCount?: number;
  restrictionConflictPolicy: {
    mode: 'prefer_source';
    expectedCount: number;
    expectedFingerprint: string;
    allowedDifferingFields: ['niveauGravite'];
    requiredParentStatus: 'abroge';
    requireSourceSeverityStrictlyHigher: true;
  };
}

export type SandreReconciliationAction =
  | ReplaceOneToOneAction
  | ReplacePartitionAction
  | PreserveLocalAction
  | CanonicalizeDuplicateAction;

export type SandreSyncExpectation =
  | {
      departmentCode: string;
      officialCodes: string[];
      resolution: 'geometry_normalization';
    }
  | {
      departmentCode: string;
      officialCodes: string[];
      resolution: 'basin_mapping';
      officialBasinCode: number;
      localBasinCode: number;
      mappingSource: string;
    };

export interface SandreReconciliationPlan {
  schemaVersion: 1;
  operationId: string;
  description: string;
  syncExpectations?: SandreSyncExpectation[];
  actions: SandreReconciliationAction[];
}

export interface SandreActionGeometryEvidence {
  sourceGeometryHash: string;
  targetGeometryHashes: string[];
  sourceCoverage: number;
  targetCoverage: number;
  iou: number;
  officialCode?: string;
  officialGid?: number;
  officialPayloadHash?: string;
  officialGeometryHash?: string;
  targetEqualsOfficial?: boolean;
}

export interface OfficialSandreGeometry {
  codeSandre: string;
  gid: number;
  departmentCode: string;
  type: 'SOU' | 'SUP';
  status: string;
  payloadHash: string;
  basinCode: number;
  geometry: unknown;
}

export interface OfficialSandreSnapshot {
  departmentCode: string;
  snapshotHash: string;
  sourceUpdatedAt: string | null;
  featureCount: number;
  features: OfficialSandreGeometry[];
}

export interface SandreSyncExpectationEvidence {
  expectation: SandreSyncExpectation;
  snapshotHash: string;
  sourceUpdatedAt: string | null;
  featureCount: number;
  features: Array<{
    codeSandre: string;
    gid: number;
    type: 'SOU' | 'SUP';
    payloadHash: string;
    basinCode: number;
    geometry: SandreGeometryAudit | null;
    basinMapping: {
      officialBasinCode: number;
      localBasinCode: number;
      mappingSource: string;
      localBasinId: number;
    } | null;
  }>;
}

export interface SandreActionAudit {
  action: SandreReconciliationAction;
  status: 'ready' | 'already_applied';
  departmentId: number;
  geometry: SandreActionGeometryEvidence | null;
  operationalReferences: {
    arreteCadre: number;
    restrictions: number;
    customizations: number;
    aliases: number;
  };
  restrictionConflicts: {
    policy: 'prefer_source';
    count: number;
    fingerprint: string;
  } | null;
}

export interface CanonicalDuplicateRestrictionConflict {
  arreteRestrictionId: number;
  parentStatus: string;
  sourceRestrictionId: number;
  targetRestrictionId: number;
  sourceArreteCadreId: number | null;
  targetArreteCadreId: number | null;
  sourceNomGroupementAep: string | null;
  targetNomGroupementAep: string | null;
  sourceNiveauGravite: string;
  targetNiveauGravite: string;
}

export interface SandreReconciliationQueryExecutor {
  query(query: string, parameters?: any[]): Promise<any[]>;
}

export interface SandreReconciliationState {
  zones: any[];
  arreteCadreLinks: any[];
  restrictions: any[];
  usages: any[];
  restrictionCommunes: any[];
  customizations: any[];
  customizationCommunes: any[];
  aliases: any[];
}

export function parseSandreReconciliationPlan(
  value: unknown,
): SandreReconciliationPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Sandre reconciliation plan');
  }
  const plan = value as Record<string, unknown>;
  if (
    plan.schemaVersion !== 1 ||
    typeof plan.operationId !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]{2,80}$/.test(plan.operationId) ||
    typeof plan.description !== 'string' ||
    !Array.isArray(plan.actions) ||
    plan.actions.length === 0
  ) {
    throw new Error('Invalid Sandre reconciliation plan header');
  }

  const actions = plan.actions.map(parseAction);
  const syncExpectations = Array.isArray(plan.syncExpectations)
    ? plan.syncExpectations.map(parseSyncExpectation)
    : undefined;
  const sourceIds = new Set<number>();
  for (const action of actions) {
    if (sourceIds.has(action.sourceZoneId)) {
      throw new Error(`Duplicate source zone ${action.sourceZoneId}`);
    }
    sourceIds.add(action.sourceZoneId);
  }
  return {
    schemaVersion: 1,
    operationId: plan.operationId,
    description: plan.description,
    ...(syncExpectations ? { syncExpectations } : {}),
    actions,
  };
}

function parseSyncExpectation(value: unknown): SandreSyncExpectation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Sandre sync expectation');
  }
  const expectation = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'departmentCode',
    'officialCodes',
    'resolution',
    'officialBasinCode',
    'localBasinCode',
    'mappingSource',
  ]);
  if (
    typeof expectation.departmentCode !== 'string' ||
    expectation.departmentCode.length === 0 ||
    expectation.departmentCode.length > 3 ||
    !Array.isArray(expectation.officialCodes) ||
    expectation.officialCodes.length === 0 ||
    expectation.officialCodes.some(
      (code) =>
        typeof code !== 'string' || code.length === 0 || code.length > 32,
    ) ||
    new Set(expectation.officialCodes).size !==
      expectation.officialCodes.length ||
    !['geometry_normalization', 'basin_mapping'].includes(
      String(expectation.resolution),
    ) ||
    Object.keys(expectation).some((key) => !allowedKeys.has(key))
  ) {
    throw new Error('Invalid Sandre sync expectation fields');
  }
  if (expectation.resolution === 'geometry_normalization') {
    if (
      expectation.officialBasinCode !== undefined ||
      expectation.localBasinCode !== undefined ||
      expectation.mappingSource !== undefined
    ) {
      throw new Error(
        'Geometry normalization expectation cannot declare a basin mapping',
      );
    }
    return {
      departmentCode: expectation.departmentCode,
      officialCodes: [...(expectation.officialCodes as string[])],
      resolution: 'geometry_normalization',
    };
  }
  if (
    !positiveInteger(expectation.officialBasinCode) ||
    !positiveInteger(expectation.localBasinCode) ||
    typeof expectation.mappingSource !== 'string' ||
    expectation.mappingSource.length === 0 ||
    expectation.mappingSource.length > 50
  ) {
    throw new Error('Invalid Sandre basin mapping expectation');
  }
  return {
    departmentCode: expectation.departmentCode,
    officialCodes: [...(expectation.officialCodes as string[])],
    resolution: 'basin_mapping',
    officialBasinCode: expectation.officialBasinCode,
    localBasinCode: expectation.localBasinCode,
    mappingSource: expectation.mappingSource,
  };
}

export function reconciliationPlanFingerprint(
  plan: SandreReconciliationPlan,
): string {
  return fingerprint(plan);
}

export async function auditSandreReconciliationPlan(
  executor: SandreReconciliationQueryExecutor,
  plan: SandreReconciliationPlan,
  officialFeatures: OfficialSandreGeometry[] = [],
): Promise<SandreActionAudit[]> {
  const audits: SandreActionAudit[] = [];
  for (const action of plan.actions) {
    audits.push(await auditAction(executor, action, officialFeatures));
  }
  return audits;
}

export async function auditSandreSyncExpectations(
  executor: SandreReconciliationQueryExecutor,
  plan: SandreReconciliationPlan,
  snapshots: OfficialSandreSnapshot[],
): Promise<SandreSyncExpectationEvidence[]> {
  const evidence: SandreSyncExpectationEvidence[] = [];
  for (const expectation of plan.syncExpectations ?? []) {
    const snapshotMatches = snapshots.filter(
      (snapshot) => snapshot.departmentCode === expectation.departmentCode,
    );
    if (snapshotMatches.length !== 1) {
      throw new Error(
        `Expected one Sandre snapshot for department ${expectation.departmentCode}`,
      );
    }
    const snapshot = snapshotMatches[0];
    if (
      !/^[a-f0-9]{64}$/.test(snapshot.snapshotHash) ||
      !Number.isInteger(snapshot.featureCount) ||
      snapshot.featureCount !== snapshot.features.length ||
      (snapshot.sourceUpdatedAt !== null &&
        !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.sourceUpdatedAt))
    ) {
      throw new Error(
        `Invalid Sandre snapshot evidence for department ${expectation.departmentCode}`,
      );
    }
    const features = expectation.officialCodes.map((code) => {
      const matches = snapshot.features.filter(
        (feature) => feature.codeSandre === code,
      );
      if (
        matches.length !== 1 ||
        matches[0].status !== 'Validé' ||
        matches[0].departmentCode !== expectation.departmentCode
      ) {
        throw new Error(
          `Expected one active Sandre feature ${code} in department ${expectation.departmentCode}`,
        );
      }
      return matches[0];
    });

    if (expectation.resolution === 'geometry_normalization') {
      const normalized = await normalizeSandreZoneGeometries(
        executor,
        features as any,
        {
          departmentCode: snapshot.departmentCode,
          snapshotHash: snapshot.snapshotHash,
          sourceUpdatedAt: snapshot.sourceUpdatedAt,
          featureCount: snapshot.featureCount,
        },
      );
      const featureEvidence = features.map((feature) => {
        const geometry = normalized.audits.get(feature.codeSandre);
        if (!geometry?.normalized) {
          throw new Error(
            `Sandre feature ${feature.codeSandre} is no longer an invalid geometry fixture`,
          );
        }
        return syncFeatureEvidence(feature, geometry, null);
      });
      evidence.push({
        expectation,
        snapshotHash: snapshot.snapshotHash,
        sourceUpdatedAt: snapshot.sourceUpdatedAt,
        featureCount: snapshot.featureCount,
        features: featureEvidence,
      });
      continue;
    }

    const featureEvidence = [];
    for (const feature of features) {
      if (feature.basinCode !== expectation.officialBasinCode) {
        throw new Error(
          `Unexpected official basin ${feature.basinCode} for Sandre feature ${feature.codeSandre}`,
        );
      }
      const mappings = await executor.query(
        `
          SELECT
            "officialBasinCode",
            "localBasinCode",
            source
          FROM sandre_basin_mapping
          WHERE "officialBasinCode" = $1
        `,
        [expectation.officialBasinCode],
      );
      if (
        mappings.length !== 1 ||
        Number(mappings[0].localBasinCode) !== expectation.localBasinCode ||
        mappings[0].source !== expectation.mappingSource
      ) {
        throw new Error(
          `Audited basin mapping mismatch for official basin ${expectation.officialBasinCode}`,
        );
      }
      const localBasins = await executor.query(
        `
          SELECT id
          FROM bassin_versant
          WHERE code = $1
          ORDER BY id
          LIMIT 2
        `,
        [expectation.localBasinCode],
      );
      if (localBasins.length !== 1) {
        throw new Error(
          `Expected one local basin ${expectation.localBasinCode}, found ${localBasins.length}`,
        );
      }
      featureEvidence.push(
        syncFeatureEvidence(feature, null, {
          officialBasinCode: Number(mappings[0].officialBasinCode),
          localBasinCode: Number(mappings[0].localBasinCode),
          mappingSource: mappings[0].source,
          localBasinId: Number(localBasins[0].id),
        }),
      );
    }
    evidence.push({
      expectation,
      snapshotHash: snapshot.snapshotHash,
      sourceUpdatedAt: snapshot.sourceUpdatedAt,
      featureCount: snapshot.featureCount,
      features: featureEvidence,
    });
  }
  return evidence;
}

function syncFeatureEvidence(
  feature: OfficialSandreGeometry,
  geometry: SandreGeometryAudit | null,
  basinMapping: SandreSyncExpectationEvidence['features'][number]['basinMapping'],
): SandreSyncExpectationEvidence['features'][number] {
  return {
    codeSandre: feature.codeSandre,
    gid: feature.gid,
    type: feature.type,
    payloadHash: feature.payloadHash,
    basinCode: feature.basinCode,
    geometry,
    basinMapping,
  };
}

export async function loadSandreReconciliationState(
  executor: SandreReconciliationQueryExecutor,
  plan: SandreReconciliationPlan,
): Promise<SandreReconciliationState> {
  return loadSandreReconciliationZoneState(
    executor,
    actionZoneIds(plan.actions),
  );
}

export async function loadSandreReconciliationZoneState(
  executor: SandreReconciliationQueryExecutor,
  zoneIds: number[],
): Promise<SandreReconciliationState> {
  if (
    zoneIds.some((zoneId) => !Number.isInteger(zoneId) || zoneId <= 0) ||
    new Set(zoneIds).size !== zoneIds.length
  ) {
    throw new Error('Invalid Sandre reconciliation zone state scope');
  }
  if (zoneIds.length === 0) {
    return {
      zones: [],
      arreteCadreLinks: [],
      restrictions: [],
      usages: [],
      restrictionCommunes: [],
      customizations: [],
      customizationCommunes: [],
      aliases: [],
    };
  }
  const sortedZoneIds = [...zoneIds].sort((left, right) => left - right);
  const zones = await executor.query(
    `
      SELECT
        zone.id,
        zone."departementId",
        department.code AS "departmentCode",
        zone.type,
        zone.code,
        zone."idSandre",
        zone."codeSandre",
        zone.disabled,
        zone."sandreProvenance",
        zone."statutSandre",
        zone."dateMajSandre",
        zone."numeroVersionSandre",
        zone."codesAlternatifs",
        zone."sandrePayloadHash",
        md5(ST_AsEWKB(zone.geom)) AS "geometryHash"
      FROM zone_alerte zone
      JOIN departement department ON department.id = zone."departementId"
      WHERE zone.id = ANY($1::integer[])
      ORDER BY zone.id
    `,
    [sortedZoneIds],
  );
  const arreteCadreLinks = await executor.query(
    `
      SELECT "arreteCadreId", "zoneAlerteId"
      FROM arrete_cadre_zone_alerte
      WHERE "zoneAlerteId" = ANY($1::integer[])
      ORDER BY "arreteCadreId", "zoneAlerteId"
    `,
    [sortedZoneIds],
  );
  const restrictions = await executor.query(
    `
      SELECT
        restriction.id,
        restriction."arreteRestrictionId",
        parent."dateDebut"::text AS "arreteRestrictionDateDebut",
        restriction."zoneAlerteId",
        restriction."arreteCadreId",
        restriction."nomGroupementAep",
        restriction."niveauGravite"
      FROM restriction
      JOIN arrete_restriction parent
        ON parent.id = restriction."arreteRestrictionId"
      WHERE "zoneAlerteId" = ANY($1::integer[])
      ORDER BY restriction.id
    `,
    [sortedZoneIds],
  );
  const usages = await executor.query(
    `
      SELECT usage.*
      FROM usage
      JOIN restriction ON restriction.id = usage."restrictionId"
      WHERE restriction."zoneAlerteId" = ANY($1::integer[])
      ORDER BY usage.id
    `,
    [sortedZoneIds],
  );
  const restrictionCommunes = await executor.query(
    `
      SELECT link."restrictionId", link."communeId"
      FROM restriction_commune link
      JOIN restriction ON restriction.id = link."restrictionId"
      WHERE restriction."zoneAlerteId" = ANY($1::integer[])
      ORDER BY link."restrictionId", link."communeId"
    `,
    [sortedZoneIds],
  );
  const customizations = await executor.query(
    `
      SELECT id, "arreteCadreId", "zoneAlerteId"
      FROM arrete_cadre_zone_alerte_communes
      WHERE "zoneAlerteId" = ANY($1::integer[])
      ORDER BY id
    `,
    [sortedZoneIds],
  );
  const customizationCommunes = await executor.query(
    `
      SELECT link."arreteCadreZoneAlerteCommunesId", link."communeId"
      FROM ac_za_communes link
      JOIN arrete_cadre_zone_alerte_communes customization
        ON customization.id = link."arreteCadreZoneAlerteCommunesId"
      WHERE customization."zoneAlerteId" = ANY($1::integer[])
      ORDER BY link."arreteCadreZoneAlerteCommunesId", link."communeId"
    `,
    [sortedZoneIds],
  );
  const aliases = await executor.query(
    `
      SELECT
        "departementId",
        "zoneAlerteId",
        "zoneType",
        "aliasType",
        "aliasValue",
        source
      FROM sandre_zone_alias
      WHERE "zoneAlerteId" = ANY($1::integer[])
      ORDER BY "departementId", "zoneType", "aliasType", "aliasValue"
    `,
    [sortedZoneIds],
  );
  return {
    zones,
    arreteCadreLinks,
    restrictions,
    usages,
    restrictionCommunes,
    customizations,
    customizationCommunes,
    aliases,
  };
}

export async function applySandreReconciliationActions(
  executor: SandreReconciliationQueryExecutor,
  audits: SandreActionAudit[],
): Promise<void> {
  for (const audit of audits) {
    if (audit.status === 'already_applied') {
      continue;
    }
    const action = audit.action;
    switch (action.strategy) {
      case 'preserve_local':
        await preserveLocalZone(executor, action);
        break;
      case 'replace_1to1':
        await replaceOneToOne(executor, action);
        break;
      case 'replace_partition_1ton':
        await replacePartition(executor, action);
        break;
      case 'canonicalize_duplicate':
        await canonicalizeDuplicate(executor, action);
        break;
    }
  }
}

export async function lockSandreReconciliationPlan(
  executor: SandreReconciliationQueryExecutor,
  plan: SandreReconciliationPlan,
): Promise<void> {
  const zoneIds = actionZoneIds(plan.actions);
  await executor.query(
    `
      SELECT id
      FROM zone_alerte
      WHERE id = ANY($1::integer[])
      ORDER BY id
      FOR UPDATE
    `,
    [zoneIds],
  );
  await executor.query(
    `
      SELECT id
      FROM arrete_cadre
      WHERE id IN (
        SELECT "arreteCadreId"
        FROM arrete_cadre_zone_alerte
        WHERE "zoneAlerteId" = ANY($1::integer[])
        UNION
        SELECT "arreteCadreId"
        FROM arrete_cadre_zone_alerte_communes
        WHERE "zoneAlerteId" = ANY($1::integer[])
      )
      ORDER BY id
      FOR UPDATE
    `,
    [zoneIds],
  );
  await executor.query(
    `
      SELECT id
      FROM arrete_restriction
      WHERE id IN (
        SELECT "arreteRestrictionId"
        FROM restriction
        WHERE "zoneAlerteId" = ANY($1::integer[])
      )
      ORDER BY id
      FOR UPDATE
    `,
    [zoneIds],
  );
  const lockTargets = [
    {
      table: 'arrete_cadre_zone_alerte',
      orderBy: '"arreteCadreId", "zoneAlerteId"',
    },
    { table: 'restriction', orderBy: 'id' },
    { table: 'arrete_cadre_zone_alerte_communes', orderBy: 'id' },
    { table: 'sandre_zone_alias', orderBy: 'id' },
  ];
  for (const { table, orderBy } of lockTargets) {
    await executor.query(
      `
        SELECT *
        FROM ${table}
        WHERE "zoneAlerteId" = ANY($1::integer[])
        ORDER BY ${orderBy}
        FOR UPDATE
      `,
      [zoneIds],
    );
  }
}

async function auditAction(
  executor: SandreReconciliationQueryExecutor,
  action: SandreReconciliationAction,
  officialFeatures: OfficialSandreGeometry[],
): Promise<SandreActionAudit> {
  const ids = actionTargetIds(action);
  const rows = await executor.query(
    `
      SELECT
        zone.id,
        zone."departementId",
        department.code AS "departmentCode",
        zone.type,
        zone.code,
        zone."idSandre",
        zone."codeSandre",
        zone.disabled,
        zone."sandreProvenance",
        zone."statutSandre",
        zone."dateMajSandre",
        zone."numeroVersionSandre",
        zone."codesAlternatifs",
        zone."sandrePayloadHash",
        md5(ST_AsEWKB(zone.geom)) AS "geometryHash",
        (
          SELECT count(*)::integer
          FROM arrete_cadre_zone_alerte link
          JOIN arrete_cadre parent ON parent.id = link."arreteCadreId"
          WHERE link."zoneAlerteId" = zone.id
            AND parent.statut IN ('a_venir', 'publie')
        ) AS "operationalArreteCadre",
        (
          SELECT count(*)::integer
          FROM restriction reference
          JOIN arrete_restriction parent
            ON parent.id = reference."arreteRestrictionId"
          WHERE reference."zoneAlerteId" = zone.id
            AND parent.statut IN ('a_venir', 'publie')
        ) AS "operationalRestrictions",
        (
          SELECT count(*)::integer
          FROM arrete_cadre_zone_alerte_communes reference
          JOIN arrete_cadre parent ON parent.id = reference."arreteCadreId"
          WHERE reference."zoneAlerteId" = zone.id
            AND parent.statut IN ('a_venir', 'publie')
        ) AS "operationalCustomizations",
        (
          SELECT count(*)::integer
          FROM sandre_zone_alias alias
          WHERE alias."zoneAlerteId" = zone.id
        ) AS aliases,
        (
          SELECT count(*)::integer
          FROM arrete_cadre_zone_alerte link
          WHERE link."zoneAlerteId" = zone.id
        ) + (
          SELECT count(*)::integer
          FROM restriction reference
          WHERE reference."zoneAlerteId" = zone.id
        ) + (
          SELECT count(*)::integer
          FROM arrete_cadre_zone_alerte_communes reference
          WHERE reference."zoneAlerteId" = zone.id
        ) AS "allBusinessReferences"
      FROM zone_alerte zone
      JOIN departement department ON department.id = zone."departementId"
      WHERE zone.id = ANY($1::integer[])
      ORDER BY zone.id
    `,
    [[action.sourceZoneId, ...ids]],
  );
  const source = rows.find((row) => Number(row.id) === action.sourceZoneId);
  const targets = ids.map((id) => rows.find((row) => Number(row.id) === id));
  if (!source || targets.some((target) => !target)) {
    throw new Error(
      `Missing zone for ${action.strategy}:${action.sourceZoneId}`,
    );
  }
  for (const zone of [source, ...targets]) {
    if (
      zone.departmentCode !== action.departmentCode ||
      zone.type !== action.zoneType
    ) {
      throw new Error(
        `Scope mismatch for zone ${zone.id}: expected ${action.departmentCode}/${action.zoneType}`,
      );
    }
  }
  if (action.expectedSourceCode && source.code !== action.expectedSourceCode) {
    throw new Error(`Unexpected legacy code for zone ${action.sourceZoneId}`);
  }

  const references = {
    arreteCadre: Number(source.operationalArreteCadre),
    restrictions: Number(source.operationalRestrictions),
    customizations: Number(source.operationalCustomizations),
    aliases: Number(source.aliases),
  };
  const alreadyApplied = actionIsAlreadyApplied(action, source, references);
  if (action.strategy === 'preserve_local') {
    if (alreadyApplied) {
      return {
        action,
        status: 'already_applied',
        departmentId: Number(source.departementId),
        geometry: null,
        operationalReferences: references,
        restrictionConflicts: null,
      };
    }
    if (source.idSandre !== null || source.codeSandre !== null) {
      throw new Error(
        `Local preserved zone ${action.sourceZoneId} has a Sandre identity`,
      );
    }
    return {
      action,
      status: 'ready',
      departmentId: Number(source.departementId),
      geometry: null,
      operationalReferences: references,
      restrictionConflicts: null,
    };
  }

  let restrictionConflicts: SandreActionAudit['restrictionConflicts'] = null;
  if (action.strategy === 'canonicalize_duplicate') {
    if (
      action.requiredSourceBusinessReferenceCount !== undefined &&
      Number(source.allBusinessReferences) !==
        action.requiredSourceBusinessReferenceCount
    ) {
      throw new Error(
        `Duplicate canonicalization source references changed for ${action.sourceZoneId}`,
      );
    }
    if (
      (!alreadyApplied &&
        Number(source.idSandre) !== action.expectedSandreGid) ||
      Number(targets[0].idSandre) !== action.expectedSandreGid ||
      targets[0].disabled === true ||
      (targets[0].codeSandre !== null &&
        targets[0].codeSandre !== action.officialCode)
    ) {
      throw new Error(
        `Duplicate canonicalization identity mismatch for ${action.sourceZoneId}`,
      );
    }
    if (!alreadyApplied) {
      restrictionConflicts = await assertCanonicalDuplicatePayloads(
        executor,
        action,
      );
    }
  } else {
    if (source.disabled !== true || targets.some((target) => target.disabled)) {
      throw new Error(
        `Replacement zones must have a disabled source and active targets`,
      );
    }
    if (
      action.strategy === 'replace_partition_1ton' &&
      (references.restrictions > 0 ||
        references.customizations > 0 ||
        references.aliases > 0)
    ) {
      throw new Error(
        `Partition ${action.sourceZoneId} supports only operational framework-order links`,
      );
    }
  }

  const geometry =
    action.strategy === 'canonicalize_duplicate'
      ? await loadCanonicalGeometryEvidence(executor, action, officialFeatures)
      : await loadActionGeometryEvidence(executor, action);
  if (action.strategy === 'replace_1to1') {
    if (
      !isStrictOneToOneGeometry({
        ...geometry,
        secondIou: 0,
        secondSourceCoverage: 0,
      })
    ) {
      throw new Error(`Unsafe 1:1 geometry for zone ${action.sourceZoneId}`);
    }
  } else if (
    action.strategy === 'canonicalize_duplicate'
      ? geometry.targetEqualsOfficial !== true ||
        geometry.sourceCoverage < 0.99 ||
        geometry.targetCoverage < 0.99 ||
        geometry.iou < 0.99
      : geometry.sourceCoverage < STRICT_GEOMETRY_THRESHOLDS.sourceCoverage ||
        geometry.targetCoverage < STRICT_GEOMETRY_THRESHOLDS.targetCoverage ||
        geometry.iou < STRICT_GEOMETRY_THRESHOLDS.iou
  ) {
    throw new Error(
      `Unsafe reconciliation geometry for zone ${action.sourceZoneId}`,
    );
  }

  if (alreadyApplied) {
    return {
      action,
      status: 'already_applied',
      departmentId: Number(source.departementId),
      geometry,
      operationalReferences: references,
      restrictionConflicts: null,
    };
  }

  return {
    action,
    status: 'ready',
    departmentId: Number(source.departementId),
    geometry,
    operationalReferences: references,
    restrictionConflicts,
  };
}

async function loadCanonicalGeometryEvidence(
  executor: SandreReconciliationQueryExecutor,
  action: CanonicalizeDuplicateAction,
  officialFeatures: OfficialSandreGeometry[],
): Promise<SandreActionGeometryEvidence> {
  const officialMatches = officialFeatures.filter(
    (feature) => feature.codeSandre === action.officialCode,
  );
  if (officialMatches.length !== 1) {
    throw new Error(
      `Expected one official Sandre feature ${action.officialCode}, found ${officialMatches.length}`,
    );
  }
  const official = officialMatches[0];
  if (
    official.gid !== action.expectedSandreGid ||
    official.departmentCode !== action.departmentCode ||
    official.type !== action.zoneType ||
    official.status !== 'Validé'
  ) {
    throw new Error(
      `Official Sandre identity mismatch for ${action.officialCode}`,
    );
  }
  const [row] = await executor.query(
    `
      WITH geometries AS (
        SELECT
          source.geom AS source_geom,
          target.geom AS target_geom,
          ST_SetSRID(ST_GeomFromGeoJSON($3), 4326) AS official_geom
        FROM zone_alerte source
        JOIN zone_alerte target ON target.id = $2
        WHERE source.id = $1
      ), measured AS (
        SELECT
          *,
          ST_Area(source_geom) AS source_area,
          ST_Area(official_geom) AS official_area,
          ST_Area(ST_Intersection(source_geom, official_geom))
            AS intersection_area,
          ST_Area(ST_Union(source_geom, official_geom)) AS union_area
        FROM geometries
      )
      SELECT
        md5(ST_AsEWKB(source_geom)) AS "sourceGeometryHash",
        ARRAY[md5(ST_AsEWKB(target_geom))] AS "targetGeometryHashes",
        md5(ST_AsEWKB(official_geom)) AS "officialGeometryHash",
        ST_Equals(target_geom, official_geom) AS "targetEqualsOfficial",
        CASE WHEN source_area = 0 THEN 0
          ELSE intersection_area / source_area END::text AS "sourceCoverage",
        CASE WHEN official_area = 0 THEN 0
          ELSE intersection_area / official_area END::text AS "targetCoverage",
        CASE WHEN union_area = 0 THEN 0
          ELSE intersection_area / union_area END::text AS iou
      FROM measured
    `,
    [
      action.sourceZoneId,
      action.targetZoneId,
      JSON.stringify(official.geometry),
    ],
  );
  return {
    sourceGeometryHash: row.sourceGeometryHash,
    targetGeometryHashes: row.targetGeometryHashes,
    sourceCoverage: Number(row.sourceCoverage),
    targetCoverage: Number(row.targetCoverage),
    iou: Number(row.iou),
    officialCode: official.codeSandre,
    officialGid: official.gid,
    officialPayloadHash: official.payloadHash,
    officialGeometryHash: row.officialGeometryHash,
    targetEqualsOfficial: row.targetEqualsOfficial === true,
  };
}

async function loadActionGeometryEvidence(
  executor: SandreReconciliationQueryExecutor,
  action: Exclude<SandreReconciliationAction, PreserveLocalAction>,
): Promise<SandreActionGeometryEvidence> {
  const targetIds = actionTargetIds(action);
  const [row] = await executor.query(
    `
      WITH source AS (
        SELECT geom
        FROM zone_alerte
        WHERE id = $1
      ), targets AS (
        SELECT
          ST_UnaryUnion(ST_Collect(geom)) AS geom,
          array_agg(md5(ST_AsEWKB(geom)) ORDER BY id) AS hashes
        FROM zone_alerte
        WHERE id = ANY($2::integer[])
      ), measured AS (
        SELECT
          source.geom AS source_geom,
          targets.geom AS target_geom,
          targets.hashes,
          ST_Area(source.geom) AS source_area,
          ST_Area(targets.geom) AS target_area,
          ST_Area(ST_Intersection(source.geom, targets.geom)) AS intersection_area,
          ST_Area(ST_Union(source.geom, targets.geom)) AS union_area
        FROM source, targets
      )
      SELECT
        md5(ST_AsEWKB(source_geom)) AS "sourceGeometryHash",
        hashes AS "targetGeometryHashes",
        CASE WHEN source_area = 0 THEN 0
          ELSE intersection_area / source_area END::text AS "sourceCoverage",
        CASE WHEN target_area = 0 THEN 0
          ELSE intersection_area / target_area END::text AS "targetCoverage",
        CASE WHEN union_area = 0 THEN 0
          ELSE intersection_area / union_area END::text AS iou
      FROM measured
    `,
    [action.sourceZoneId, targetIds],
  );
  return {
    sourceGeometryHash: row.sourceGeometryHash,
    targetGeometryHashes: row.targetGeometryHashes,
    sourceCoverage: Number(row.sourceCoverage),
    targetCoverage: Number(row.targetCoverage),
    iou: Number(row.iou),
  };
}

async function assertCanonicalDuplicatePayloads(
  executor: SandreReconciliationQueryExecutor,
  action: CanonicalizeDuplicateAction,
): Promise<NonNullable<SandreActionAudit['restrictionConflicts']>> {
  const rows = await executor.query(
    `
      SELECT
        source."arreteRestrictionId" AS "arreteRestrictionId",
        parent.statut AS "parentStatus",
        source.id AS "sourceRestrictionId",
        target.id AS "targetRestrictionId",
        source."arreteCadreId" AS "sourceArreteCadreId",
        target."arreteCadreId" AS "targetArreteCadreId",
        source."nomGroupementAep" AS "sourceNomGroupementAep",
        target."nomGroupementAep" AS "targetNomGroupementAep",
        source."niveauGravite" AS "sourceNiveauGravite",
        target."niveauGravite" AS "targetNiveauGravite",
        ARRAY(
          SELECT link."communeId"
          FROM restriction_commune link
          WHERE link."restrictionId" = source.id
          ORDER BY link."communeId"
        ) AS "sourceCommuneIds",
        ARRAY(
          SELECT link."communeId"
          FROM restriction_commune link
          WHERE link."restrictionId" = target.id
          ORDER BY link."communeId"
        ) AS "targetCommuneIds"
      FROM restriction source
      JOIN restriction target
        ON target."arreteRestrictionId" = source."arreteRestrictionId"
       AND target."zoneAlerteId" = $2
      JOIN arrete_restriction parent
        ON parent.id = source."arreteRestrictionId"
      WHERE source."zoneAlerteId" = $1
      ORDER BY source."arreteRestrictionId", source.id, target.id
    `,
    [action.sourceZoneId, action.targetZoneId],
  );
  if (
    rows.some(
      (row) =>
        row.sourceArreteCadreId !== row.targetArreteCadreId ||
        row.sourceNomGroupementAep !== row.targetNomGroupementAep,
    )
  ) {
    throw new Error(
      `Canonical duplicate restriction fields differ for zone ${action.sourceZoneId}`,
    );
  }
  if (
    rows.some(
      (row) =>
        row.parentStatus !==
        action.restrictionConflictPolicy.requiredParentStatus,
    )
  ) {
    throw new Error(
      `Canonical duplicate restriction parent status changed for zone ${action.sourceZoneId}`,
    );
  }
  if (
    rows.some(
      (row) =>
        fingerprint(row.sourceCommuneIds) !== fingerprint(row.targetCommuneIds),
    )
  ) {
    throw new Error(
      `Canonical duplicate restriction communes differ for zone ${action.sourceZoneId}`,
    );
  }
  const restrictionConflicts = rows
    .filter((row) => row.sourceNiveauGravite !== row.targetNiveauGravite)
    .map((row) => ({
      arreteRestrictionId: Number(row.arreteRestrictionId),
      parentStatus: String(row.parentStatus),
      sourceRestrictionId: Number(row.sourceRestrictionId),
      targetRestrictionId: Number(row.targetRestrictionId),
      sourceArreteCadreId:
        row.sourceArreteCadreId === null
          ? null
          : Number(row.sourceArreteCadreId),
      targetArreteCadreId:
        row.targetArreteCadreId === null
          ? null
          : Number(row.targetArreteCadreId),
      sourceNomGroupementAep: row.sourceNomGroupementAep ?? null,
      targetNomGroupementAep: row.targetNomGroupementAep ?? null,
      sourceNiveauGravite: String(row.sourceNiveauGravite),
      targetNiveauGravite: String(row.targetNiveauGravite),
    }));
  const restrictionConflictEvidence =
    assertCanonicalDuplicateRestrictionConflicts(action, restrictionConflicts);
  const usageRows = await executor.query(
    `
      SELECT source.id
      FROM usage source
      JOIN restriction source_restriction
        ON source_restriction.id = source."restrictionId"
      JOIN restriction target_restriction
        ON target_restriction."arreteRestrictionId" =
          source_restriction."arreteRestrictionId"
       AND target_restriction."zoneAlerteId" = $2
      JOIN usage target
        ON target."restrictionId" = target_restriction.id
       AND target.nom = source.nom
       AND target."thematiqueId" = source."thematiqueId"
      WHERE source_restriction."zoneAlerteId" = $1
        AND (
          to_jsonb(source) - ARRAY['id', 'restrictionId']::text[]
        ) IS DISTINCT FROM (
          to_jsonb(target) - ARRAY['id', 'restrictionId']::text[]
        )
      LIMIT 1
    `,
    [action.sourceZoneId, action.targetZoneId],
  );
  if (usageRows.length > 0) {
    throw new Error(
      `Canonical duplicate usages differ for zone ${action.sourceZoneId}`,
    );
  }
  return restrictionConflictEvidence;
}

const RESTRICTION_SEVERITY_RANK: Record<string, number> = {
  vigilance: 1,
  alerte: 2,
  alerte_renforcee: 3,
  crise: 4,
};

export function assertCanonicalDuplicateRestrictionConflicts(
  action: CanonicalizeDuplicateAction,
  conflicts: CanonicalDuplicateRestrictionConflict[],
): NonNullable<SandreActionAudit['restrictionConflicts']> {
  for (const conflict of conflicts) {
    const sourceRank = RESTRICTION_SEVERITY_RANK[conflict.sourceNiveauGravite];
    const targetRank = RESTRICTION_SEVERITY_RANK[conflict.targetNiveauGravite];
    if (!sourceRank || !targetRank || sourceRank <= targetRank) {
      throw new Error(
        `Canonical duplicate source severity is not stronger for restriction ${conflict.arreteRestrictionId}`,
      );
    }
  }
  const count = conflicts.length;
  const conflictFingerprint = fingerprint(conflicts);
  const expected = action.restrictionConflictPolicy;
  if (
    count !== expected.expectedCount ||
    conflictFingerprint !== expected.expectedFingerprint
  ) {
    throw new Error(
      `Canonical duplicate restriction conflicts changed for zone ${action.sourceZoneId}`,
    );
  }
  return {
    policy: expected.mode,
    count,
    fingerprint: conflictFingerprint,
  };
}

async function preserveLocalZone(
  executor: SandreReconciliationQueryExecutor,
  action: PreserveLocalAction,
): Promise<void> {
  await executor.query(
    `DELETE FROM sandre_zone_alias WHERE "zoneAlerteId" = $1`,
    [action.sourceZoneId],
  );
  await executor.query(
    `
      UPDATE zone_alerte
      SET
        disabled = false,
        "idSandre" = NULL,
        "codeSandre" = NULL,
        "statutSandre" = NULL,
        "dateMajSandre" = NULL,
        "numeroVersionSandre" = NULL,
        "codesAlternatifs" = NULL,
        "sandrePayloadHash" = NULL,
        "sandreProvenance" = 'local_preserved',
        "updatedAt" = now()
      WHERE id = $1
    `,
    [action.sourceZoneId],
  );
}

async function replaceOneToOne(
  executor: SandreReconciliationQueryExecutor,
  action: ReplaceOneToOneAction,
): Promise<void> {
  await moveOperationalArreteCadreLinks(executor, action.sourceZoneId, [
    action.targetZoneId,
  ]);
  await executor.query(
    `
      UPDATE restriction reference
      SET "zoneAlerteId" = $2
      FROM arrete_restriction parent
      WHERE reference."arreteRestrictionId" = parent.id
        AND reference."zoneAlerteId" = $1
        AND parent.statut IN ('a_venir', 'publie')
    `,
    [action.sourceZoneId, action.targetZoneId],
  );
  await executor.query(
    `
      UPDATE arrete_cadre_zone_alerte_communes reference
      SET "zoneAlerteId" = $2
      FROM arrete_cadre parent
      WHERE reference."arreteCadreId" = parent.id
        AND reference."zoneAlerteId" = $1
        AND parent.statut IN ('a_venir', 'publie')
    `,
    [action.sourceZoneId, action.targetZoneId],
  );
  await executor.query(
    `
      UPDATE sandre_zone_alias
      SET "zoneAlerteId" = $2
      WHERE "zoneAlerteId" = $1
    `,
    [action.sourceZoneId, action.targetZoneId],
  );
}

async function replacePartition(
  executor: SandreReconciliationQueryExecutor,
  action: ReplacePartitionAction,
): Promise<void> {
  await moveOperationalArreteCadreLinks(
    executor,
    action.sourceZoneId,
    action.targetZoneIds,
  );
}

async function moveOperationalArreteCadreLinks(
  executor: SandreReconciliationQueryExecutor,
  sourceZoneId: number,
  targetZoneIds: number[],
): Promise<void> {
  await executor.query(
    `
      INSERT INTO arrete_cadre_zone_alerte ("arreteCadreId", "zoneAlerteId")
      SELECT link."arreteCadreId", target.id
      FROM arrete_cadre_zone_alerte link
      JOIN arrete_cadre parent ON parent.id = link."arreteCadreId"
      CROSS JOIN unnest($2::integer[]) AS target(id)
      WHERE link."zoneAlerteId" = $1
        AND parent.statut IN ('a_venir', 'publie')
      ON CONFLICT DO NOTHING
    `,
    [sourceZoneId, targetZoneIds],
  );
  await executor.query(
    `
      DELETE FROM arrete_cadre_zone_alerte link
      USING arrete_cadre parent
      WHERE link."arreteCadreId" = parent.id
        AND link."zoneAlerteId" = $1
        AND parent.statut IN ('a_venir', 'publie')
    `,
    [sourceZoneId],
  );
}

async function canonicalizeDuplicate(
  executor: SandreReconciliationQueryExecutor,
  action: CanonicalizeDuplicateAction,
): Promise<void> {
  const parameters = [action.sourceZoneId, action.targetZoneId];
  await executor.query(
    `
      INSERT INTO arrete_cadre_zone_alerte ("arreteCadreId", "zoneAlerteId")
      SELECT "arreteCadreId", $2
      FROM arrete_cadre_zone_alerte
      WHERE "zoneAlerteId" = $1
      ON CONFLICT DO NOTHING
    `,
    parameters,
  );
  await executor.query(
    `
      DELETE FROM arrete_cadre_zone_alerte
      WHERE "zoneAlerteId" = $1
    `,
    [action.sourceZoneId],
  );
  await executor.query('DROP TABLE IF EXISTS sandre_duplicate_restriction');
  await executor.query(
    `
      CREATE TEMPORARY TABLE sandre_duplicate_restriction
      ON COMMIT DROP AS
      SELECT source.id AS source_id, target.id AS target_id
      FROM restriction source
      JOIN restriction target
        ON target."arreteRestrictionId" = source."arreteRestrictionId"
       AND target."zoneAlerteId" = $2
      WHERE source."zoneAlerteId" = $1
    `,
    parameters,
  );
  await executor.query(`
      UPDATE restriction target
      SET "niveauGravite" = source."niveauGravite"
      FROM sandre_duplicate_restriction duplicate
      JOIN restriction source ON source.id = duplicate.source_id
      WHERE target.id = duplicate.target_id
        AND source."niveauGravite" IS DISTINCT FROM target."niveauGravite"
  `);
  await executor.query(`
      INSERT INTO restriction_commune ("restrictionId", "communeId")
      SELECT duplicate.target_id, link."communeId"
      FROM restriction_commune link
      JOIN sandre_duplicate_restriction duplicate
        ON duplicate.source_id = link."restrictionId"
      ON CONFLICT DO NOTHING
  `);
  await executor.query(`
      DELETE FROM restriction_commune link
      USING sandre_duplicate_restriction duplicate
      WHERE link."restrictionId" = duplicate.source_id
  `);
  await executor.query(`
      DELETE FROM usage source
      USING usage target, sandre_duplicate_restriction duplicate
      WHERE source."restrictionId" = duplicate.source_id
        AND target."restrictionId" = duplicate.target_id
        AND target.nom = source.nom
        AND target."thematiqueId" = source."thematiqueId"
  `);
  await executor.query(`
      UPDATE usage source
      SET "restrictionId" = duplicate.target_id
      FROM sandre_duplicate_restriction duplicate
      WHERE source."restrictionId" = duplicate.source_id
  `);
  await executor.query(`
      DELETE FROM restriction source
      USING sandre_duplicate_restriction duplicate
      WHERE source.id = duplicate.source_id
  `);
  await executor.query(
    `
      UPDATE restriction
      SET "zoneAlerteId" = $2
      WHERE "zoneAlerteId" = $1
    `,
    parameters,
  );
  await executor.query('DROP TABLE IF EXISTS sandre_duplicate_customization');
  await executor.query(
    `
      CREATE TEMPORARY TABLE sandre_duplicate_customization
      ON COMMIT DROP AS
      SELECT source.id AS source_id, target.id AS target_id
      FROM arrete_cadre_zone_alerte_communes source
      JOIN arrete_cadre_zone_alerte_communes target
        ON target."arreteCadreId" = source."arreteCadreId"
       AND target."zoneAlerteId" = $2
      WHERE source."zoneAlerteId" = $1
    `,
    parameters,
  );
  await executor.query(`
      INSERT INTO ac_za_communes (
        "arreteCadreZoneAlerteCommunesId",
        "communeId"
      )
      SELECT duplicate.target_id, link."communeId"
      FROM ac_za_communes link
      JOIN sandre_duplicate_customization duplicate
        ON duplicate.source_id = link."arreteCadreZoneAlerteCommunesId"
      ON CONFLICT DO NOTHING
  `);
  await executor.query(`
      DELETE FROM ac_za_communes link
      USING sandre_duplicate_customization duplicate
      WHERE link."arreteCadreZoneAlerteCommunesId" = duplicate.source_id
  `);
  await executor.query(`
      DELETE FROM arrete_cadre_zone_alerte_communes source
      USING sandre_duplicate_customization duplicate
      WHERE source.id = duplicate.source_id
  `);
  await executor.query(
    `
      UPDATE arrete_cadre_zone_alerte_communes
      SET "zoneAlerteId" = $2
      WHERE "zoneAlerteId" = $1
    `,
    parameters,
  );
  await executor.query(
    `
      DELETE FROM sandre_zone_alias source
      USING sandre_zone_alias target
      WHERE source."zoneAlerteId" = $1
        AND target."zoneAlerteId" = $2
        AND target."departementId" = source."departementId"
        AND target."zoneType" = source."zoneType"
        AND target."aliasType" = source."aliasType"
        AND target."aliasValue" = source."aliasValue"
    `,
    parameters,
  );
  await executor.query(
    `
      UPDATE sandre_zone_alias
      SET "zoneAlerteId" = $2
      WHERE "zoneAlerteId" = $1
    `,
    parameters,
  );
  await executor.query(
    `
      UPDATE zone_alerte
      SET
        disabled = true,
        "idSandre" = NULL,
        "codeSandre" = NULL,
        "statutSandre" = NULL,
        "dateMajSandre" = NULL,
        "numeroVersionSandre" = NULL,
        "codesAlternatifs" = NULL,
        "sandrePayloadHash" = NULL,
        "sandreProvenance" = 'legacy_unverified',
        "updatedAt" = now()
      WHERE id = $1
    `,
    [action.sourceZoneId],
  );
}

function actionIsAlreadyApplied(
  action: SandreReconciliationAction,
  source: any,
  references: SandreActionAudit['operationalReferences'],
): boolean {
  if (action.strategy === 'preserve_local') {
    return (
      source.disabled === false &&
      source.sandreProvenance === 'local_preserved' &&
      source.idSandre === null &&
      source.codeSandre === null &&
      source.statutSandre === null &&
      source.dateMajSandre === null &&
      source.numeroVersionSandre === null &&
      (source.codesAlternatifs === null ||
        (Array.isArray(source.codesAlternatifs) &&
          source.codesAlternatifs.length === 0)) &&
      source.sandrePayloadHash === null &&
      references.aliases === 0
    );
  }
  if (action.strategy === 'canonicalize_duplicate') {
    return (
      source.disabled === true &&
      source.idSandre === null &&
      source.codeSandre === null &&
      source.statutSandre === null &&
      source.dateMajSandre === null &&
      source.numeroVersionSandre === null &&
      (source.codesAlternatifs === null ||
        (Array.isArray(source.codesAlternatifs) &&
          source.codesAlternatifs.length === 0)) &&
      source.sandrePayloadHash === null &&
      source.sandreProvenance === 'legacy_unverified' &&
      Number(source.allBusinessReferences) === 0 &&
      references.aliases === 0
    );
  }
  return (
    references.arreteCadre === 0 &&
    references.restrictions === 0 &&
    references.customizations === 0 &&
    references.aliases === 0
  );
}

function parseAction(value: unknown): SandreReconciliationAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Sandre reconciliation action');
  }
  const action = value as Record<string, unknown>;
  if (
    ![
      'replace_1to1',
      'replace_partition_1ton',
      'preserve_local',
      'canonicalize_duplicate',
    ].includes(String(action.strategy)) ||
    typeof action.departmentCode !== 'string' ||
    !['SOU', 'SUP'].includes(String(action.zoneType)) ||
    !positiveInteger(action.sourceZoneId) ||
    (action.expectedSourceCode !== undefined &&
      typeof action.expectedSourceCode !== 'string')
  ) {
    throw new Error('Invalid Sandre reconciliation action fields');
  }
  if (action.strategy === 'replace_partition_1ton') {
    if (
      !Array.isArray(action.targetZoneIds) ||
      action.targetZoneIds.length < 2 ||
      action.targetZoneIds.some((id) => !positiveInteger(id)) ||
      new Set(action.targetZoneIds).size !== action.targetZoneIds.length ||
      action.targetZoneIds.includes(action.sourceZoneId)
    ) {
      throw new Error('Invalid partition targets');
    }
  } else if (action.strategy !== 'preserve_local') {
    if (
      !positiveInteger(action.targetZoneId) ||
      action.targetZoneId === action.sourceZoneId
    ) {
      throw new Error('Invalid reconciliation target');
    }
  }
  if (
    action.strategy === 'canonicalize_duplicate' &&
    (!positiveInteger(action.expectedSandreGid) ||
      typeof action.officialCode !== 'string' ||
      action.officialCode.length === 0 ||
      action.officialCode.length > 32 ||
      !isCanonicalRestrictionConflictPolicy(action.restrictionConflictPolicy) ||
      (action.requiredSourceBusinessReferenceCount !== undefined &&
        (!Number.isInteger(action.requiredSourceBusinessReferenceCount) ||
          Number(action.requiredSourceBusinessReferenceCount) < 0)))
  ) {
    throw new Error('Invalid canonical Sandre duplicate action');
  }
  if (
    action.strategy !== 'canonicalize_duplicate' &&
    action.restrictionConflictPolicy !== undefined
  ) {
    throw new Error(
      'Restriction conflict resolution is only valid for canonical duplicates',
    );
  }
  if (
    action.restrictionReplicationPolicy !== undefined ||
    action.officialSplitEvidence !== undefined
  ) {
    throw new Error('Legacy partition evidence is not supported');
  }
  return action as unknown as SandreReconciliationAction;
}

function isCanonicalRestrictionConflictPolicy(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const policy = value as Record<string, unknown>;
  return (
    Object.keys(policy).sort().join(',') ===
      'allowedDifferingFields,expectedCount,expectedFingerprint,mode,requireSourceSeverityStrictlyHigher,requiredParentStatus' &&
    policy.mode === 'prefer_source' &&
    Number.isInteger(policy.expectedCount) &&
    Number(policy.expectedCount) >= 0 &&
    typeof policy.expectedFingerprint === 'string' &&
    /^[a-f0-9]{64}$/.test(policy.expectedFingerprint) &&
    Array.isArray(policy.allowedDifferingFields) &&
    policy.allowedDifferingFields.length === 1 &&
    policy.allowedDifferingFields[0] === 'niveauGravite' &&
    policy.requiredParentStatus === 'abroge' &&
    policy.requireSourceSeverityStrictlyHigher === true
  );
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function actionTargetIds(action: SandreReconciliationAction): number[] {
  if (action.strategy === 'preserve_local') {
    return [];
  }
  return action.strategy === 'replace_partition_1ton'
    ? [...action.targetZoneIds].sort((left, right) => left - right)
    : [action.targetZoneId];
}

function actionZoneIds(actions: SandreReconciliationAction[]): number[] {
  return [
    ...new Set(
      actions.flatMap((action) => [
        action.sourceZoneId,
        ...actionTargetIds(action),
      ]),
    ),
  ].sort((left, right) => left - right);
}
