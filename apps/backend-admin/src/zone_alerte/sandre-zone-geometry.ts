import { createHash } from 'crypto';
import { SandreZoneFeature } from './sandre-zone-sync';

export const SANDRE_GEOMETRY_MAX_RELATIVE_AREA_DELTA = 1e-9;

export interface SandreGeometryAudit {
  codeSandre: string;
  normalized: boolean;
  invalidReason: string;
  rawGeometryHash: string;
  normalizedGeometryHash: string;
  rawGeometryType: string;
  normalizedGeometryType: string;
  rawParts: number;
  normalizedParts: number;
  rawPoints: number;
  normalizedPoints: number;
  rawArea: number;
  normalizedArea: number;
  relativeAreaDelta: number;
}

export interface SandreGeometryQueryExecutor {
  query(query: string, parameters?: any[]): Promise<any[]>;
}

export async function normalizeSandreZoneGeometries(
  executor: SandreGeometryQueryExecutor,
  features: SandreZoneFeature[],
): Promise<{
  features: SandreZoneFeature[];
  audits: Map<string, SandreGeometryAudit>;
}> {
  if (features.length === 0) {
    return { features: [], audits: new Map() };
  }
  if (
    new Set(features.map((feature) => feature.codeSandre)).size !==
    features.length
  ) {
    throw new Error('Duplicate Sandre code in geometry normalization input');
  }

  const rows = await executor.query(
    `
      WITH sandre_geometry_input AS (
        SELECT
          ordinality::integer AS ordinal,
          item->>'code' AS code,
          ST_SetSRID(
            ST_GeomFromGeoJSON((item->'geometry')::text),
            4326
          ) AS raw_geom
        FROM jsonb_array_elements($1::jsonb)
          WITH ORDINALITY AS input(item, ordinality)
      ), repaired AS (
        SELECT
          ordinal,
          code,
          raw_geom,
          CASE
            WHEN ST_IsValid(raw_geom) THEN raw_geom
            ELSE ST_Multi(
              ST_CollectionExtract(
                ST_MakeValid(
                  raw_geom,
                  'method=structure keepcollapsed=false'
                ),
                3
              )
            )
          END AS normalized_geom
        FROM sandre_geometry_input
      ), measured AS (
        SELECT
          *,
          ST_Area(raw_geom) AS raw_area,
          ST_Area(normalized_geom) AS normalized_area
        FROM repaired
      )
      SELECT
        ordinal,
        code,
        ST_AsGeoJSON(normalized_geom, 15, 0)::jsonb AS geometry,
        ST_IsValid(raw_geom) AS raw_valid,
        ST_IsValidReason(raw_geom) AS invalid_reason,
        GeometryType(raw_geom) AS raw_geometry_type,
        GeometryType(normalized_geom) AS normalized_geometry_type,
        ST_NumGeometries(raw_geom)::integer AS raw_parts,
        ST_NumGeometries(normalized_geom)::integer AS normalized_parts,
        ST_NPoints(raw_geom)::integer AS raw_points,
        ST_NPoints(normalized_geom)::integer AS normalized_points,
        raw_area::text AS raw_area,
        normalized_area::text AS normalized_area,
        CASE
          WHEN GREATEST(abs(raw_area), abs(normalized_area)) = 0 THEN 0
          ELSE abs(normalized_area - raw_area)
            / GREATEST(abs(raw_area), abs(normalized_area))
        END::text AS relative_area_delta,
        (
          ST_XMin(Box3D(normalized_geom)) = ST_XMin(Box3D(raw_geom))
          AND ST_XMax(Box3D(normalized_geom)) = ST_XMax(Box3D(raw_geom))
          AND ST_YMin(Box3D(normalized_geom)) = ST_YMin(Box3D(raw_geom))
          AND ST_YMax(Box3D(normalized_geom)) = ST_YMax(Box3D(raw_geom))
        ) AS bbox_unchanged,
        (
          NOT ST_IsEmpty(normalized_geom)
          AND ST_IsValid(normalized_geom)
          AND GeometryType(normalized_geom) IN ('POLYGON', 'MULTIPOLYGON')
          AND ST_XMin(Box3D(normalized_geom)) >= -180
          AND ST_XMax(Box3D(normalized_geom)) <= 180
          AND ST_YMin(Box3D(normalized_geom)) >= -90
          AND ST_YMax(Box3D(normalized_geom)) <= 90
        ) AS normalized_valid
      FROM measured
      ORDER BY ordinal
    `,
    [
      JSON.stringify(
        features.map((feature) => ({
          code: feature.codeSandre,
          geometry: feature.geometry,
        })),
      ),
    ],
  );

  if (rows.length !== features.length) {
    throw new Error(
      `Sandre geometry normalization returned ${rows.length}/${features.length} rows`,
    );
  }

  const normalizedFeatures: SandreZoneFeature[] = [];
  const audits = new Map<string, SandreGeometryAudit>();
  for (let index = 0; index < features.length; index++) {
    const row = rows[index];
    const feature = features[index];
    if (Number(row.ordinal) !== index + 1 || row.code !== feature.codeSandre) {
      throw new Error('Sandre geometry normalization order changed');
    }
    const relativeAreaDelta = Number(row.relative_area_delta);
    if (
      row.normalized_valid !== true ||
      row.bbox_unchanged !== true ||
      !row.geometry ||
      !Number.isFinite(relativeAreaDelta) ||
      relativeAreaDelta > SANDRE_GEOMETRY_MAX_RELATIVE_AREA_DELTA
    ) {
      throw new Error(
        `Unsafe Sandre geometry normalization for zone ${feature.codeSandre}: ` +
          `valid=${row.normalized_valid === true}, ` +
          `bboxUnchanged=${row.bbox_unchanged === true}, ` +
          `areaDelta=${relativeAreaDelta}`,
      );
    }

    const normalizedGeometry =
      row.raw_valid === true ? feature.geometry : row.geometry;
    const normalizedFeature = {
      ...feature,
      geometry: normalizedGeometry,
    } as SandreZoneFeature;
    const audit: SandreGeometryAudit = {
      codeSandre: feature.codeSandre,
      normalized: row.raw_valid !== true,
      invalidReason: String(row.invalid_reason),
      rawGeometryHash: hashGeometry(feature.geometry),
      normalizedGeometryHash: hashGeometry(normalizedGeometry),
      rawGeometryType: String(row.raw_geometry_type),
      normalizedGeometryType: String(row.normalized_geometry_type),
      rawParts: Number(row.raw_parts),
      normalizedParts: Number(row.normalized_parts),
      rawPoints: Number(row.raw_points),
      normalizedPoints: Number(row.normalized_points),
      rawArea: Number(row.raw_area),
      normalizedArea: Number(row.normalized_area),
      relativeAreaDelta,
    };
    normalizedFeatures.push(normalizedFeature);
    audits.set(feature.codeSandre, audit);
  }

  return { features: normalizedFeatures, audits };
}

function hashGeometry(geometry: unknown): string {
  return createHash('sha256').update(JSON.stringify(geometry)).digest('hex');
}
