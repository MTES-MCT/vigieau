import { SandreZoneFeature, SandreZoneSnapshot } from './sandre-zone-sync';
import { fingerprint } from './sandre-zone-reconciliation';

export interface SandreLkgFeatureEvidence {
  codeSandre: string;
  gid: number;
  departmentCode: string;
  sourceUpdatedAt: string;
  name: string;
  type: 'SOU' | 'SUP';
  status: 'Gelé' | 'Validé';
  payloadHash: string;
  geometryEvidenceSha256: string;
}

export interface SandreLkgLocalZoneEvidence {
  zoneAlerteId: number;
  bassinVersantId: number;
  bassinVersantCode: number;
  idSandre: number;
  codeSandre: string;
  code: string;
  nom: string;
  type: 'SOU' | 'SUP';
  ressourceInfluencee: boolean;
  disabled: boolean;
  sandreProvenance: 'official' | 'legacy_unverified' | 'local_preserved';
  statutSandre: string | null;
  dateMajSandre: string | null;
  numeroVersionSandre: number | null;
  numeroVersion: number | null;
  sandrePayloadHash: string | null;
  ewkbMd5: string;
}

export interface SandreLkgMdmRecord {
  codeSandre: string;
  projectionSha256: string;
  requiredEvolution: null;
}

export interface SandreLkgApproval {
  approvalId: string;
  departmentCode: string;
  snapshotHash: string;
  sourceUpdatedAt: string;
  featureCount: number;
  feature: SandreLkgFeatureEvidence & { status: 'Gelé' };
  localZone: SandreLkgLocalZoneEvidence;
  mdmRecords: SandreLkgMdmRecord[];
  mdmNomenclature: null;
  genealogyLatestDate: string;
  genealogySourceRelationCount: 0;
  genealogyEvidenceFingerprint: string;
  operationalReferenceEvidenceFingerprint: string;
  reconciliationStateFingerprint: string;
}

export interface SandreLkgObservation {
  departmentCode: string;
  snapshot: {
    snapshotHash: string;
    sourceUpdatedAt: string | null;
    featureCount: number;
  };
  feature: SandreLkgFeatureEvidence;
  localZone: SandreLkgLocalZoneEvidence;
  mdmRecords: SandreLkgMdmRecord[];
  mdmNomenclature: null;
  genealogyLatestDate: string;
  genealogySourceRelationCount: number;
  genealogyEvidenceFingerprint: string;
  operationalReferenceEvidenceFingerprint: string;
  reconciliationStateFingerprint: string;
}

const APPROVAL_KEYS = [
  'approvalId',
  'departmentCode',
  'feature',
  'featureCount',
  'genealogyEvidenceFingerprint',
  'genealogyLatestDate',
  'genealogySourceRelationCount',
  'localZone',
  'mdmNomenclature',
  'mdmRecords',
  'operationalReferenceEvidenceFingerprint',
  'reconciliationStateFingerprint',
  'snapshotHash',
  'sourceUpdatedAt',
] as const;

const FEATURE_KEYS = [
  'codeSandre',
  'departmentCode',
  'geometryEvidenceSha256',
  'gid',
  'name',
  'payloadHash',
  'sourceUpdatedAt',
  'status',
  'type',
] as const;

const LOCAL_ZONE_KEYS = [
  'bassinVersantCode',
  'bassinVersantId',
  'code',
  'codeSandre',
  'dateMajSandre',
  'disabled',
  'ewkbMd5',
  'idSandre',
  'nom',
  'numeroVersion',
  'numeroVersionSandre',
  'ressourceInfluencee',
  'sandrePayloadHash',
  'sandreProvenance',
  'statutSandre',
  'type',
  'zoneAlerteId',
] as const;

const MDM_RECORD_KEYS = [
  'codeSandre',
  'projectionSha256',
  'requiredEvolution',
] as const;

export const SANDRE_LKG_APPROVALS: readonly SandreLkgApproval[] =
  createRegistry([
    {
      approvalId: 'dep06-zone-3862-lkg-bdf7e4da',
      departmentCode: '06',
      snapshotHash:
        'bdf7e4daed8cbfbaee78693ffcc2d72c34f269792b0367078d85b687f6701007',
      sourceUpdatedAt: '2026-08-17',
      featureCount: 55,
      feature: {
        codeSandre: '3862',
        gid: 3862,
        departmentCode: '06',
        sourceUpdatedAt: '2026-08-17',
        name: 'Saint Cassien',
        type: 'SUP',
        status: 'Gelé',
        payloadHash:
          '93fe07f4dc784a847dc34a2d865870e61ae1b7eecb67eea79bb68fbbaf66621d',
        geometryEvidenceSha256:
          '70c171dd3575846521cb46cb3e10a1844ae60969a70893be93102b039be0a1f3',
      },
      localZone: {
        zoneAlerteId: 16629,
        bassinVersantId: 7,
        bassinVersantCode: 6,
        idSandre: 3862,
        codeSandre: '3862',
        code: '3862',
        nom: 'Saint Cassien',
        type: 'SUP',
        ressourceInfluencee: true,
        disabled: false,
        sandreProvenance: 'official',
        statutSandre: 'Validé',
        dateMajSandre: '2026-07-08',
        numeroVersionSandre: null,
        numeroVersion: null,
        sandrePayloadHash:
          '1617bc1563650121931b8b0d11d64102f0658dba574a81d669fc70d899048543',
        ewkbMd5: '2ef01c7adc7b6d6a2edc2f629c67e6dd',
      },
      mdmRecords: [
        {
          codeSandre: '3862',
          projectionSha256:
            'd7215cbfa4afd3adc1beb70e3f807510ba63c8f78f857f502a6b246587ef48dc',
          requiredEvolution: null,
        },
      ],
      mdmNomenclature: null,
      genealogyLatestDate: '2024-10-01',
      genealogySourceRelationCount: 0,
      genealogyEvidenceFingerprint:
        '9be65b636c9b650351c8c49521dab48a84df4d91401fe06e5b15a58fc3b56394',
      operationalReferenceEvidenceFingerprint:
        '92eb63115b974328dd83c031bd6f747d66dcb491e8689e3774057ca86c94e7c3',
      reconciliationStateFingerprint:
        '52319a44546bfec9b2061cbef418156eeed3e0e10039a8fcf8e4ffa8bc6a18e2',
    },
  ]);

export function findSandreLkgApproval(
  departmentCode: string,
  snapshot: SandreZoneSnapshot,
): SandreLkgApproval | null {
  const approval =
    SANDRE_LKG_APPROVALS.find(
      (candidate) => candidate.departmentCode === departmentCode,
    ) ?? null;
  if (
    !approval ||
    snapshot.snapshotHash !== approval.snapshotHash ||
    snapshot.sourceUpdatedAt !== approval.sourceUpdatedAt ||
    snapshot.featureCount !== approval.featureCount ||
    snapshot.features.length !== approval.featureCount
  ) {
    return null;
  }

  const matchingFeatures = snapshot.features.filter(
    (feature) => feature.codeSandre === approval.feature.codeSandre,
  );
  if (matchingFeatures.length !== 1) {
    return null;
  }
  return featureMatchesApproval(matchingFeatures[0], approval.feature)
    ? approval
    : null;
}

export const findSandreApprovedLkgRetentionForSnapshot = findSandreLkgApproval;

export function findSandreApprovedLkgRetentionForObservation(
  observation: SandreLkgObservation,
): SandreLkgApproval | null {
  const approval = SANDRE_LKG_APPROVALS.find(
    (candidate) =>
      candidate.departmentCode === observation.departmentCode &&
      candidate.feature.codeSandre === observation.feature.codeSandre &&
      candidate.localZone.zoneAlerteId === observation.localZone.zoneAlerteId,
  );
  if (!approval) {
    return null;
  }

  try {
    assertSandreLkgObservation(approval, observation);
    return approval;
  } catch {
    return null;
  }
}

export function assertSandreLkgObservation(
  approval: SandreLkgApproval,
  observation: SandreLkgObservation,
): void {
  if (!approvalMatchesObservation(approval, observation)) {
    throw new Error(
      `Sandre LKG observation changed for approval ${approval.approvalId}`,
    );
  }
}

export function sandreLkgFeatureEvidence(
  feature: SandreZoneFeature,
): SandreLkgFeatureEvidence {
  return {
    codeSandre: feature.codeSandre,
    gid: feature.gid,
    departmentCode: feature.departmentCode,
    sourceUpdatedAt: feature.sourceUpdatedAt,
    name: feature.name,
    type: feature.type,
    status: feature.status,
    payloadHash: feature.payloadHash,
    geometryEvidenceSha256: fingerprint({
      type: feature.geometry?.type,
      coordinates: feature.geometry?.coordinates,
    }),
  };
}

function featureMatchesApproval(
  feature: SandreZoneFeature,
  expected: SandreLkgFeatureEvidence,
): boolean {
  const observed = sandreLkgFeatureEvidence(feature);
  return (
    observed.codeSandre === expected.codeSandre &&
    observed.gid === expected.gid &&
    observed.departmentCode === expected.departmentCode &&
    observed.sourceUpdatedAt === expected.sourceUpdatedAt &&
    observed.name === expected.name &&
    observed.type === expected.type &&
    observed.status === expected.status &&
    observed.payloadHash === expected.payloadHash &&
    observed.geometryEvidenceSha256 === expected.geometryEvidenceSha256
  );
}

export function parseSandreLkgApproval(value: unknown): SandreLkgApproval {
  if (!isRecord(value) || !hasExactKeys(value, APPROVAL_KEYS)) {
    throw new Error('Invalid Sandre LKG approval');
  }
  const feature = value.feature;
  const localZone = value.localZone;
  const mdmRecords = value.mdmRecords;
  const mdmRecord = Array.isArray(mdmRecords) ? mdmRecords[0] : null;
  if (
    !isRecord(feature) ||
    !hasExactKeys(feature, FEATURE_KEYS) ||
    !isRecord(localZone) ||
    !hasExactKeys(localZone, LOCAL_ZONE_KEYS) ||
    !Array.isArray(mdmRecords) ||
    mdmRecords.length !== 1 ||
    !isRecord(mdmRecord) ||
    !hasExactKeys(mdmRecord, MDM_RECORD_KEYS) ||
    typeof value.approvalId !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{7,99}$/.test(value.approvalId) ||
    typeof value.departmentCode !== 'string' ||
    !/^(?:\d{2,3}|2[AB])$/.test(value.departmentCode) ||
    !isSha256(value.snapshotHash) ||
    !isCivilDate(value.sourceUpdatedAt) ||
    !isPositiveInteger(value.featureCount) ||
    typeof feature.codeSandre !== 'string' ||
    !/^\d{1,32}$/.test(feature.codeSandre) ||
    !isPositiveInteger(feature.gid) ||
    feature.departmentCode !== value.departmentCode ||
    feature.sourceUpdatedAt !== value.sourceUpdatedAt ||
    typeof feature.name !== 'string' ||
    feature.name.length === 0 ||
    feature.name.length > 200 ||
    !isZoneType(feature.type) ||
    feature.status !== 'Gelé' ||
    !isSha256(feature.payloadHash) ||
    !isSha256(feature.geometryEvidenceSha256) ||
    !isPositiveInteger(localZone.zoneAlerteId) ||
    !isPositiveInteger(localZone.bassinVersantId) ||
    !isPositiveInteger(localZone.bassinVersantCode) ||
    !isPositiveInteger(localZone.idSandre) ||
    localZone.idSandre !== feature.gid ||
    typeof localZone.codeSandre !== 'string' ||
    localZone.codeSandre !== feature.codeSandre ||
    typeof localZone.code !== 'string' ||
    localZone.code.length === 0 ||
    localZone.code.length > 32 ||
    typeof localZone.nom !== 'string' ||
    localZone.nom.length === 0 ||
    localZone.nom.length > 200 ||
    !isZoneType(localZone.type) ||
    localZone.type !== feature.type ||
    typeof localZone.ressourceInfluencee !== 'boolean' ||
    localZone.disabled !== false ||
    localZone.sandreProvenance !== 'official' ||
    localZone.statutSandre !== 'Validé' ||
    !isCivilDate(localZone.dateMajSandre) ||
    !isOptionalNonNegativeInteger(localZone.numeroVersionSandre) ||
    !isOptionalNonNegativeInteger(localZone.numeroVersion) ||
    !isSha256(localZone.sandrePayloadHash) ||
    !isMd5(localZone.ewkbMd5) ||
    typeof mdmRecord.codeSandre !== 'string' ||
    mdmRecord.codeSandre !== feature.codeSandre ||
    !isSha256(mdmRecord.projectionSha256) ||
    mdmRecord.requiredEvolution !== null ||
    value.mdmNomenclature !== null ||
    !isCivilDate(value.genealogyLatestDate) ||
    value.genealogySourceRelationCount !== 0 ||
    !isSha256(value.genealogyEvidenceFingerprint) ||
    !isSha256(value.operationalReferenceEvidenceFingerprint) ||
    !isSha256(value.reconciliationStateFingerprint)
  ) {
    throw new Error(
      `Invalid Sandre LKG approval for department ${String(value.departmentCode)}`,
    );
  }

  return Object.freeze({
    approvalId: value.approvalId,
    departmentCode: value.departmentCode,
    snapshotHash: value.snapshotHash,
    sourceUpdatedAt: value.sourceUpdatedAt,
    featureCount: value.featureCount,
    feature: Object.freeze({
      codeSandre: feature.codeSandre,
      gid: feature.gid,
      departmentCode: feature.departmentCode,
      sourceUpdatedAt: feature.sourceUpdatedAt,
      name: feature.name,
      type: feature.type,
      status: feature.status,
      payloadHash: feature.payloadHash,
      geometryEvidenceSha256: feature.geometryEvidenceSha256,
    }),
    localZone: Object.freeze({
      zoneAlerteId: localZone.zoneAlerteId,
      bassinVersantId: localZone.bassinVersantId,
      bassinVersantCode: localZone.bassinVersantCode,
      idSandre: localZone.idSandre,
      codeSandre: localZone.codeSandre,
      code: localZone.code,
      nom: localZone.nom,
      type: localZone.type,
      ressourceInfluencee: localZone.ressourceInfluencee,
      disabled: localZone.disabled,
      sandreProvenance: localZone.sandreProvenance,
      statutSandre: localZone.statutSandre,
      dateMajSandre: localZone.dateMajSandre,
      numeroVersionSandre: localZone.numeroVersionSandre,
      numeroVersion: localZone.numeroVersion,
      sandrePayloadHash: localZone.sandrePayloadHash,
      ewkbMd5: localZone.ewkbMd5,
    }),
    mdmRecords: Object.freeze([
      Object.freeze({
        codeSandre: mdmRecord.codeSandre,
        projectionSha256: mdmRecord.projectionSha256,
        requiredEvolution: null,
      }),
    ]) as SandreLkgMdmRecord[],
    mdmNomenclature: null,
    genealogyLatestDate: value.genealogyLatestDate,
    genealogySourceRelationCount: 0,
    genealogyEvidenceFingerprint: value.genealogyEvidenceFingerprint,
    operationalReferenceEvidenceFingerprint:
      value.operationalReferenceEvidenceFingerprint,
    reconciliationStateFingerprint: value.reconciliationStateFingerprint,
  });
}

function createRegistry(
  values: readonly unknown[],
): readonly SandreLkgApproval[] {
  const approvals = values.map(parseSandreLkgApproval);
  const approvalIds = approvals.map((approval) => approval.approvalId);
  const scopes = approvals.map(
    (approval) =>
      `${approval.departmentCode}:${approval.snapshotHash}:${approval.feature.codeSandre}:${approval.localZone.zoneAlerteId}`,
  );
  if (
    new Set(approvalIds).size !== approvalIds.length ||
    new Set(scopes).size !== scopes.length
  ) {
    throw new Error('Duplicate Sandre LKG approval');
  }
  return Object.freeze(approvals);
}

function approvalMatchesObservation(
  approval: SandreLkgApproval,
  observation: SandreLkgObservation,
): boolean {
  const expected = {
    departmentCode: approval.departmentCode,
    snapshot: {
      snapshotHash: approval.snapshotHash,
      sourceUpdatedAt: approval.sourceUpdatedAt,
      featureCount: approval.featureCount,
    },
    feature: approval.feature,
    localZone: approval.localZone,
    mdmRecords: approval.mdmRecords,
    mdmNomenclature: approval.mdmNomenclature,
    genealogyLatestDate: approval.genealogyLatestDate,
    genealogySourceRelationCount: approval.genealogySourceRelationCount,
    genealogyEvidenceFingerprint: approval.genealogyEvidenceFingerprint,
    operationalReferenceEvidenceFingerprint:
      approval.operationalReferenceEvidenceFingerprint,
    reconciliationStateFingerprint: approval.reconciliationStateFingerprint,
  };
  return fingerprint(observation) === fingerprint(expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isOptionalNonNegativeInteger(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && Number(value) >= 0);
}

function isCivilDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isZoneType(value: unknown): value is 'SOU' | 'SUP' {
  return value === 'SOU' || value === 'SUP';
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isMd5(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}
