// Certified by the public historic GeoJSON artifact for 2022-06-18.
export const LEGACY_HISTORIC_EMPTY_GEOMETRY_ZONE_IDS = Object.freeze([7626]);

export function isExactEmptyMultiPolygonGeometry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const geometry = value as { type?: unknown; coordinates?: unknown };
  return (
    geometry.type === 'MultiPolygon' &&
    Array.isArray(geometry.coordinates) &&
    geometry.coordinates.length === 0
  );
}
