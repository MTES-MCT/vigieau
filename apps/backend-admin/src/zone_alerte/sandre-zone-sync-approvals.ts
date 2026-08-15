import { fingerprint } from './sandre-zone-reconciliation';
import { SandreZoneFeature, SandreZoneSnapshot } from './sandre-zone-sync';

export interface SandreApprovedSyncMapping {
  sourceCode: string;
  sourceZoneId: number;
  targetCodes: string[];
  requireTopologicalEquality: boolean;
  effectiveDate: string | null;
  expectedGeometry: {
    sourceGeometryHash: string;
    targetGeometryHashes: string[];
    unionGeometryHash: string;
    sourceCoverage: number;
    targetCoverage: number;
    iou: number;
  } | null;
  minimumGeometry: {
    sourceCoverage: number;
    targetCoverage: number;
    iou: number;
  };
}

export interface SandreApprovedGeometryEvidence {
  sourceGeometryHash: string;
  targetGeometryHashes: string[];
  unionGeometryHash: string;
  sourceCoverage: number;
  targetCoverage: number;
  iou: number;
  pairwiseOverlapRatio: number;
  topologicallyEqual: boolean;
  sourceValid: boolean;
  targetsValid: boolean;
  sourceSrid: number;
  targetsSrid: number;
  sourceType: string;
  targetType: string;
}

export interface SandreApprovedGeometryQueryExecutor {
  query(query: string, parameters?: any[]): Promise<any[]>;
}

export interface SandreMdmZoneExpectation {
  codeSandre: string;
  projectionSha256: string;
  requiredEvolution: {
    typeNid: string;
    date: string;
    comment: string;
  } | null;
}

export interface SandreApprovedSyncSnapshot {
  approvalId: string;
  departmentCode: string;
  snapshotHash: string;
  sourceUpdatedAt: string;
  featureCount: number;
  featureEvidenceFingerprint: string;
  expectedSourceCount: number;
  expectedTargetCount: number;
  mappings: SandreApprovedSyncMapping[];
  mdmRecords: SandreMdmZoneExpectation[];
  mdmNomenclature: SandreMdmNomenclatureExpectation | null;
}

export interface SandreMdmNomenclatureExpectation {
  nid: string;
  nomenclatureCode: string;
  title: string;
  code: string;
  mnemonic: string;
  projectionSha256: string;
}

const DEPARTMENT_24_MAPPINGS: SandreApprovedSyncMapping[] = [
  partitionMapping('1028', 12097, ['4116', '4117'], '2026-08-05', {
    sourceGeometryHash: '1dfe5df2047067b2403c5275ca269945',
    targetGeometryHashes: [
      '93f4317d20505889d136a35ff5d8015f',
      'd21eee234aa3e64316c17775cc6f1f47',
    ],
    unionGeometryHash: '28ce8d6311c791c0cf3eebb696e1d59f',
    sourceCoverage: 0.9999922468432514,
    targetCoverage: 0.9999929950328335,
    iou: 0.9999852419847116,
  }),
  mapping('1029', 12098, ['4077']),
  mapping('1030', 12099, ['4080']),
  mapping('1032', 12102, ['4065']),
  mapping('1033', 12104, ['4115']),
  mapping('1034', 12107, ['4066']),
  mapping('1035', 12110, ['4112']),
  mapping('1037', 12112, ['4111']),
  mapping('1040', 12115, ['4090']),
  mapping('1041', 12116, ['4109']),
  mapping('1045', 12124, ['4071']),
  mapping('1048', 12131, ['4072']),
  mapping('1049', 12132, ['4073']),
  mapping('1050', 12135, ['4074']),
  mapping('1051', 12136, ['4075']),
  mapping('1052', 12137, ['4110']),
  mapping('1053', 12139, ['4107']),
  mapping('1054', 12140, ['4108']),
  mapping('1531', 12111, ['4098']),
  mapping('1540', 12092, ['4063']),
  mapping('1541', 12093, ['4083']),
  mapping('1542', 12094, ['4064']),
  mapping('1543', 12095, ['4079']),
  mapping('1545', 12096, ['4069']),
  mapping('1547', 12100, ['4081']),
  mapping('1548', 12101, ['4082']),
  mapping('1549', 12103, ['4106']),
  mapping('1550', 12105, ['4084']),
  mapping('1551', 12106, ['4085']),
  mapping('1552', 12108, ['4086']),
  mapping('1553', 12109, ['4087']),
  mapping('1554', 12113, ['4088']),
  mapping('1555', 12114, ['4089']),
  mapping('1556', 12121, ['4091']),
  mapping('1557', 12117, ['4092']),
  mapping('1558', 12118, ['4113']),
  mapping('1559', 12119, ['4094']),
  mapping('1561', 12120, ['4095']),
  mapping('1562', 12127, ['4093']),
  mapping('1563', 12122, ['4097']),
  mapping('1564', 12128, ['4096']),
  mapping('1565', 12123, ['4099']),
  mapping('1567', 12125, ['4100']),
  mapping('1568', 12126, ['4070']),
  mapping('1570', 12129, ['4101']),
  mapping('1572', 12130, ['4102']),
  mapping('1575', 12133, ['4103']),
  mapping('1576', 12134, ['4104']),
  mapping('1577', 12138, ['4105']),
  mapping('1578', 12141, ['4068']),
  mapping('1579', 12142, ['4076']),
  mapping('1580', 12143, ['4067']),
  mapping('3934', 16712, ['4078']),
  mapping('3935', 16713, ['4114']),
];

export const SANDRE_APPROVED_SYNC_SNAPSHOTS: readonly SandreApprovedSyncSnapshot[] =
  Object.freeze([
    approval({
      approvalId: 'dep24-snapshot-b8ea0408',
      departmentCode: '24',
      snapshotHash:
        'b8ea0408f5ae1910f1ff51d68e6ad81a6f46f08cb4df5d84c0fff3ad624f86b0',
      sourceUpdatedAt: '2026-08-05',
      featureCount: 110,
      featureEvidenceFingerprint:
        '0b11da69b6e8f526a3c543078d8c926d9a18f8f85ce5cc9ab78eb0f86fd0aac1',
      expectedSourceCount: 54,
      expectedTargetCount: 55,
      mappings: DEPARTMENT_24_MAPPINGS,
      mdmRecords: [],
      mdmNomenclature: null,
    }),
    approval({
      approvalId: 'dep85-split-355-snapshot-934aa655',
      departmentCode: '85',
      snapshotHash:
        '934aa655f60af4ee61f5ba533b365b4ba75dc37671f95ab2b73c99a03b008324',
      sourceUpdatedAt: '2026-06-30',
      featureCount: 26,
      featureEvidenceFingerprint:
        'df2652912748bb7847e7d67c49b2647c6624ad13818874089d3a49c20961248f',
      expectedSourceCount: 1,
      expectedTargetCount: 2,
      mappings: [
        partitionMapping('355', 10582, ['3947', '3948'], '2026-06-30', {
          sourceGeometryHash: '22fe8aef4b0c2742a1adc3caa9e31ccc',
          targetGeometryHashes: [
            'e5f1c73a7d9322e889f65d838a176a47',
            '73d4b862c4f9972f6d8b2d6f85f0085b',
          ],
          unionGeometryHash: '6e8a2ec00f197fcdb664122695102ffc',
          sourceCoverage: 0.9999888461090162,
          targetCoverage: 0.9999894571755797,
          iou: 0.9999783035197829,
        }),
      ],
      mdmRecords: [
        {
          codeSandre: '355',
          projectionSha256:
            'b7b16963402b459df4f882bc18962a284167d725fd05e718ca1ac68666b97504',
          requiredEvolution: null,
        },
        {
          codeSandre: '3947',
          projectionSha256:
            '098dd3dc60cfdda243c57446c3ae65239236f7fc7e4b6bc3bc783e262497d2fa',
          requiredEvolution: {
            typeNid: '282836',
            date: '2026-06-30 00:00:00',
            comment: 'Division de la ZAS 355',
          },
        },
        {
          codeSandre: '3948',
          projectionSha256:
            '7ae78c09c40975d09e3ce51bc8b7db433fd0651b178d501e38a0e112f8f59b06',
          requiredEvolution: {
            typeNid: '282836',
            date: '2026-06-30 00:00:00',
            comment: 'Division de la ZAS 355',
          },
        },
      ],
      mdmNomenclature: {
        nid: '282836',
        nomenclatureCode: '590',
        title: 'Création',
        code: '7',
        mnemonic: 'Création',
        projectionSha256:
          'a14aea447a72ba382e3645c02b89dda903c38f2b147cab46b605ff455387020d',
      },
    }),
  ]);

export function findSandreApprovedSyncSnapshot(
  departmentCode: string,
  snapshot: SandreZoneSnapshot,
): SandreApprovedSyncSnapshot | null {
  const approval =
    SANDRE_APPROVED_SYNC_SNAPSHOTS.find(
      (candidate) => candidate.departmentCode === departmentCode,
    ) ?? null;
  if (
    !approval ||
    snapshot.snapshotHash !== approval.snapshotHash ||
    snapshot.sourceUpdatedAt !== approval.sourceUpdatedAt ||
    snapshot.featureCount !== approval.featureCount
  ) {
    return null;
  }

  const featureEvidence = sandreSnapshotFeatureEvidence(snapshot);
  if (fingerprint(featureEvidence) !== approval.featureEvidenceFingerprint) {
    throw new Error(
      `Approved Sandre feature evidence changed for department ${departmentCode}`,
    );
  }
  const featuresByCode = new Map(
    snapshot.features.map((feature) => [feature.codeSandre, feature]),
  );
  for (const item of approval.mappings) {
    assertFeature(featuresByCode.get(item.sourceCode), item.sourceCode, 'Gelé');
    for (const targetCode of item.targetCodes) {
      assertFeature(featuresByCode.get(targetCode), targetCode, 'Validé');
    }
  }
  return approval;
}

export function sandreSnapshotFeatureEvidence(
  snapshot: SandreZoneSnapshot,
): Array<{
  codeSandre: string;
  gid: number;
  status: string;
  type: string;
  payloadHash: string;
  geometryHash: string;
}> {
  return snapshot.features
    .map((feature) => ({
      codeSandre: feature.codeSandre,
      gid: feature.gid,
      status: feature.status,
      type: feature.type,
      payloadHash: feature.payloadHash,
      geometryHash: fingerprint({
        type: feature.geometry?.type,
        coordinates: feature.geometry?.coordinates,
      }),
    }))
    .sort((left, right) => left.codeSandre.localeCompare(right.codeSandre));
}

export async function auditSandreApprovedSyncGeometry(
  executor: SandreApprovedGeometryQueryExecutor,
  mapping: SandreApprovedSyncMapping,
  targetFeatures: SandreZoneFeature[],
): Promise<SandreApprovedGeometryEvidence> {
  if (
    targetFeatures.length !== mapping.targetCodes.length ||
    targetFeatures.some(
      (feature) => !mapping.targetCodes.includes(feature.codeSandre),
    )
  ) {
    throw new Error(
      `Approved Sandre targets changed for source ${mapping.sourceCode}`,
    );
  }
  const [row] = await executor.query(
    `
      WITH source AS (
        SELECT geom
        FROM zone_alerte
        WHERE id = $1
      ), target_items AS (
        SELECT
          item.code,
          ST_Multi(ST_CollectionExtract(ST_MakeValid(
            ST_SetSRID(ST_GeomFromGeoJSON(item.geometry::text), 4326)
          ), 3)) AS geom
        FROM jsonb_to_recordset($2::jsonb)
          AS item(code text, geometry jsonb)
      ), targets AS (
        SELECT
          ST_UnaryUnion(ST_Collect(geom)) AS geom,
          array_agg(md5(ST_AsEWKB(geom)) ORDER BY code) AS hashes,
          bool_and(ST_IsValid(geom)) AS valid,
          min(ST_SRID(geom)) AS min_srid,
          max(ST_SRID(geom)) AS max_srid
        FROM target_items
      ), overlap AS (
        SELECT COALESCE(sum(ST_Area(ST_Intersection(left_item.geom, right_item.geom))), 0)
          AS area
        FROM target_items left_item
        JOIN target_items right_item ON left_item.code < right_item.code
      ), measured AS (
        SELECT
          source.geom AS source_geom,
          targets.geom AS target_geom,
          targets.hashes,
          targets.valid AS targets_valid,
          targets.min_srid,
          targets.max_srid,
          overlap.area AS overlap_area,
          ST_Area(source.geom) AS source_area,
          ST_Area(targets.geom) AS target_area,
          ST_Area(ST_Intersection(source.geom, targets.geom)) AS intersection_area,
          ST_Area(ST_Union(source.geom, targets.geom)) AS union_area
        FROM source, targets, overlap
      )
      SELECT
        md5(ST_AsEWKB(source_geom)) AS "sourceGeometryHash",
        hashes AS "targetGeometryHashes",
        md5(ST_AsEWKB(target_geom)) AS "unionGeometryHash",
        CASE WHEN source_area = 0 THEN 0
          ELSE intersection_area / source_area END::text AS "sourceCoverage",
        CASE WHEN target_area = 0 THEN 0
          ELSE intersection_area / target_area END::text AS "targetCoverage",
        CASE WHEN union_area = 0 THEN 0
          ELSE intersection_area / union_area END::text AS iou,
        CASE WHEN target_area = 0 THEN 0
          ELSE overlap_area / target_area END::text AS "pairwiseOverlapRatio",
        ST_Equals(source_geom, target_geom) AS "topologicallyEqual",
        ST_IsValid(source_geom) AS "sourceValid",
        targets_valid AS "targetsValid",
        ST_SRID(source_geom) AS "sourceSrid",
        CASE WHEN min_srid = max_srid THEN min_srid ELSE NULL END AS "targetsSrid",
        GeometryType(source_geom) AS "sourceType",
        GeometryType(target_geom) AS "targetType"
      FROM measured
    `,
    [
      mapping.sourceZoneId,
      JSON.stringify(
        targetFeatures.map((feature) => ({
          code: feature.codeSandre,
          geometry: feature.geometry,
        })),
      ),
    ],
  );
  if (!row) {
    throw new Error(
      `Approved Sandre source zone ${mapping.sourceZoneId} is missing`,
    );
  }
  const evidence: SandreApprovedGeometryEvidence = {
    sourceGeometryHash: String(row.sourceGeometryHash),
    targetGeometryHashes: row.targetGeometryHashes ?? [],
    unionGeometryHash: String(row.unionGeometryHash),
    sourceCoverage: Number(row.sourceCoverage),
    targetCoverage: Number(row.targetCoverage),
    iou: Number(row.iou),
    pairwiseOverlapRatio: Number(row.pairwiseOverlapRatio),
    topologicallyEqual: row.topologicallyEqual === true,
    sourceValid: row.sourceValid === true,
    targetsValid: row.targetsValid === true,
    sourceSrid: Number(row.sourceSrid),
    targetsSrid: Number(row.targetsSrid),
    sourceType: String(row.sourceType),
    targetType: String(row.targetType),
  };
  if (
    !evidence.sourceValid ||
    !evidence.targetsValid ||
    evidence.sourceSrid !== 4326 ||
    evidence.targetsSrid !== 4326 ||
    !['POLYGON', 'MULTIPOLYGON'].includes(evidence.sourceType) ||
    !['POLYGON', 'MULTIPOLYGON'].includes(evidence.targetType) ||
    evidence.sourceCoverage < mapping.minimumGeometry.sourceCoverage ||
    evidence.targetCoverage < mapping.minimumGeometry.targetCoverage ||
    evidence.iou < mapping.minimumGeometry.iou ||
    evidence.pairwiseOverlapRatio > 1e-10 ||
    (mapping.requireTopologicalEquality && !evidence.topologicallyEqual) ||
    (mapping.expectedGeometry !== null &&
      (evidence.sourceGeometryHash !==
        mapping.expectedGeometry.sourceGeometryHash ||
        evidence.unionGeometryHash !==
          mapping.expectedGeometry.unionGeometryHash ||
        fingerprint(evidence.targetGeometryHashes) !==
          fingerprint(mapping.expectedGeometry.targetGeometryHashes)))
  ) {
    throw new Error(
      `Approved Sandre geometry changed for source ${mapping.sourceCode}`,
    );
  }
  return evidence;
}

export async function assertSandreApprovedMaterializedTargets(
  executor: SandreApprovedGeometryQueryExecutor,
  departmentId: number,
  targets: Array<{
    feature: SandreZoneFeature;
    zoneAlerteId: number;
  }>,
): Promise<void> {
  const rows = await executor.query(
    `
      WITH expected AS (
        SELECT
          item.code,
          item."zoneAlerteId",
          ST_Multi(ST_CollectionExtract(ST_MakeValid(
            ST_SetSRID(ST_GeomFromGeoJSON(item.geometry::text), 4326)
          ), 3)) AS geom
        FROM jsonb_to_recordset($2::jsonb) AS item(
          code text,
          "zoneAlerteId" integer,
          geometry jsonb
        )
      )
      SELECT
        expected.code,
        zone.id AS "zoneAlerteId",
        zone."codeSandre",
        zone.disabled,
        zone.type,
        zone."departementId",
        md5(ST_AsEWKB(zone.geom)) AS "localGeometryHash",
        md5(ST_AsEWKB(expected.geom)) AS "expectedGeometryHash",
        ST_Equals(zone.geom, expected.geom) AS "topologicallyEqual"
      FROM expected
      LEFT JOIN zone_alerte zone
        ON zone.id = expected."zoneAlerteId"
        AND zone."departementId" = $1
      ORDER BY expected.code
    `,
    [
      departmentId,
      JSON.stringify(
        targets.map(({ feature, zoneAlerteId }) => ({
          code: feature.codeSandre,
          zoneAlerteId,
          geometry: feature.geometry,
        })),
      ),
    ],
  );
  if (
    rows.length !== targets.length ||
    rows.some(
      (row) =>
        !Number.isInteger(Number(row.zoneAlerteId)) ||
        row.codeSandre !== row.code ||
        row.disabled !== false ||
        row.type !== 'SUP' ||
        Number(row.departementId) !== departmentId ||
        row.localGeometryHash !== row.expectedGeometryHash ||
        row.topologicallyEqual !== true,
    )
  ) {
    throw new Error('Approved Sandre materialized target geometry changed');
  }
}

function mapping(
  sourceCode: string,
  sourceZoneId: number,
  targetCodes: string[],
): SandreApprovedSyncMapping {
  return {
    sourceCode,
    sourceZoneId,
    targetCodes,
    requireTopologicalEquality: targetCodes.length === 1,
    effectiveDate: null,
    expectedGeometry: null,
    minimumGeometry: {
      sourceCoverage: 0.999999999,
      targetCoverage: 0.999999999,
      iou: 0.999999999,
    },
  };
}

function partitionMapping(
  sourceCode: string,
  sourceZoneId: number,
  targetCodes: string[],
  effectiveDate: string,
  expectedGeometry: NonNullable<SandreApprovedSyncMapping['expectedGeometry']>,
): SandreApprovedSyncMapping {
  const margin = 1e-7;
  return {
    sourceCode,
    sourceZoneId,
    targetCodes,
    requireTopologicalEquality: false,
    effectiveDate,
    expectedGeometry,
    minimumGeometry: {
      sourceCoverage: expectedGeometry.sourceCoverage - margin,
      targetCoverage: expectedGeometry.targetCoverage - margin,
      iou: expectedGeometry.iou - margin,
    },
  };
}

function approval(
  value: SandreApprovedSyncSnapshot,
): SandreApprovedSyncSnapshot {
  const sources = value.mappings.map((item) => item.sourceCode);
  const sourceIds = value.mappings.map((item) => item.sourceZoneId);
  const targets = value.mappings.flatMap((item) => item.targetCodes);
  const approvedCodes = new Set([...sources, ...targets]);
  const mdmCodes = value.mdmRecords.map((record) => record.codeSandre);
  const splitMappings = value.mappings.filter(
    (item) => item.targetCodes.length > 1,
  );
  const mdmEvidenceInvalid =
    value.mdmRecords.length === 0
      ? value.mdmNomenclature !== null
      : !value.mdmNomenclature ||
        new Set(mdmCodes).size !== approvedCodes.size ||
        [...approvedCodes].some((code) => !mdmCodes.includes(code)) ||
        fingerprint({
          nid: value.mdmNomenclature.nid,
          nomenclatureCode: value.mdmNomenclature.nomenclatureCode,
          title: value.mdmNomenclature.title,
          code: value.mdmNomenclature.code,
          mnemonic: value.mdmNomenclature.mnemonic,
        }) !== value.mdmNomenclature.projectionSha256 ||
        splitMappings.some((item) => {
          const source = value.mdmRecords.find(
            (record) => record.codeSandre === item.sourceCode,
          );
          return (
            !source ||
            source.requiredEvolution !== null ||
            item.targetCodes.some((targetCode) => {
              const target = value.mdmRecords.find(
                (record) => record.codeSandre === targetCode,
              );
              return (
                !target?.requiredEvolution ||
                target.requiredEvolution.typeNid !==
                  value.mdmNomenclature!.nid ||
                target.requiredEvolution.date.slice(0, 10) !==
                  item.effectiveDate
              );
            })
          );
        });
  if (
    !/^[a-z0-9-]{8,100}$/.test(value.approvalId) ||
    sources.length !== value.expectedSourceCount ||
    targets.length !== value.expectedTargetCount ||
    new Set(sources).size !== sources.length ||
    new Set(sourceIds).size !== sourceIds.length ||
    new Set(targets).size !== targets.length ||
    sources.some((source) => targets.includes(source)) ||
    value.mappings.some(
      (item) =>
        !Number.isInteger(item.sourceZoneId) ||
        item.sourceZoneId <= 0 ||
        !/^\d{1,32}$/.test(item.sourceCode) ||
        item.targetCodes.length === 0 ||
        item.targetCodes.some((code) => !/^\d{1,32}$/.test(code)) ||
        Object.values(item.minimumGeometry).some(
          (threshold) =>
            !Number.isFinite(threshold) || threshold < 0.9999 || threshold > 1,
        ) ||
        item.requireTopologicalEquality !== (item.targetCodes.length === 1) ||
        (item.targetCodes.length === 1
          ? item.effectiveDate !== null || item.expectedGeometry !== null
          : !/^\d{4}-\d{2}-\d{2}$/.test(item.effectiveDate ?? '') ||
            item.expectedGeometry === null ||
            !/^[a-f0-9]{32}$/.test(item.expectedGeometry.sourceGeometryHash) ||
            !/^[a-f0-9]{32}$/.test(item.expectedGeometry.unionGeometryHash) ||
            item.expectedGeometry.targetGeometryHashes.length !==
              item.targetCodes.length ||
            item.expectedGeometry.targetGeometryHashes.some(
              (hash) => !/^[a-f0-9]{32}$/.test(hash),
            ) ||
            Object.values({
              sourceCoverage: item.expectedGeometry.sourceCoverage,
              targetCoverage: item.expectedGeometry.targetCoverage,
              iou: item.expectedGeometry.iou,
            }).some(
              (observed) =>
                !Number.isFinite(observed) || observed < 0.9999 || observed > 1,
            ) ||
            (['sourceCoverage', 'targetCoverage', 'iou'] as const).some(
              (key) =>
                item.minimumGeometry[key] > item.expectedGeometry![key] ||
                item.expectedGeometry![key] - item.minimumGeometry[key] > 1e-7,
            )),
    ) ||
    new Set(mdmCodes).size !== mdmCodes.length ||
    mdmEvidenceInvalid ||
    value.mdmRecords.some(
      (record) =>
        !approvedCodes.has(record.codeSandre) ||
        !/^[a-f0-9]{64}$/.test(record.projectionSha256) ||
        (record.requiredEvolution !== null &&
          (!/^\d+$/.test(record.requiredEvolution.typeNid) ||
            !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(
              record.requiredEvolution.date,
            ) ||
            record.requiredEvolution.comment.length === 0 ||
            record.requiredEvolution.comment.length > 500)),
    ) ||
    (value.mdmNomenclature !== null &&
      (!/^\d+$/.test(value.mdmNomenclature.nid) ||
        !/^\d+$/.test(value.mdmNomenclature.nomenclatureCode) ||
        !/^\d+$/.test(value.mdmNomenclature.code) ||
        value.mdmNomenclature.title.length === 0 ||
        value.mdmNomenclature.mnemonic.length === 0 ||
        !/^[a-f0-9]{64}$/.test(value.mdmNomenclature.projectionSha256))) ||
    !/^[a-f0-9]{64}$/.test(value.snapshotHash) ||
    !/^[a-f0-9]{64}$/.test(value.featureEvidenceFingerprint)
  ) {
    throw new Error(
      `Invalid Sandre sync approval for department ${value.departmentCode}`,
    );
  }
  return Object.freeze({
    ...value,
    mappings: Object.freeze(
      value.mappings.map((item) =>
        Object.freeze({
          ...item,
          targetCodes: Object.freeze([...item.targetCodes]) as string[],
          minimumGeometry: Object.freeze({ ...item.minimumGeometry }),
          expectedGeometry: item.expectedGeometry
            ? Object.freeze({
                ...item.expectedGeometry,
                targetGeometryHashes: Object.freeze([
                  ...item.expectedGeometry.targetGeometryHashes,
                ]) as string[],
              })
            : null,
        }),
      ),
    ) as SandreApprovedSyncMapping[],
    mdmRecords: Object.freeze(
      value.mdmRecords.map((record) =>
        Object.freeze({
          ...record,
          requiredEvolution: record.requiredEvolution
            ? Object.freeze({ ...record.requiredEvolution })
            : null,
        }),
      ),
    ) as SandreMdmZoneExpectation[],
    mdmNomenclature: value.mdmNomenclature
      ? Object.freeze({ ...value.mdmNomenclature })
      : null,
  });
}

function assertFeature(
  feature: SandreZoneFeature | undefined,
  expectedCode: string,
  expectedStatus: SandreZoneFeature['status'],
): void {
  if (
    !feature ||
    feature.codeSandre !== expectedCode ||
    feature.status !== expectedStatus ||
    feature.type !== 'SUP'
  ) {
    throw new Error(
      `Approved Sandre feature ${expectedCode}/${expectedStatus} is missing`,
    );
  }
}
