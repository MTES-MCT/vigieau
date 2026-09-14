export type GeometryBounds = [[number, number], [number, number]];

// Coordinate nesting before reaching an individual [longitude, latitude] position.
const coordinateDepth: Record<string, number> = {
  Point: 0,
  MultiPoint: 1,
  LineString: 1,
  MultiLineString: 2,
  Polygon: 2,
  MultiPolygon: 3,
};

export function getGeometryBounds(geometries: readonly unknown[]): GeometryBounds | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  const visitCoordinates = (coordinates: unknown, depth: number): void => {
    if (!Array.isArray(coordinates)) return;
    if (depth > 0) {
      coordinates.forEach((child) => visitCoordinates(child, depth - 1));
      return;
    }
    const [longitude, latitude] = coordinates;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(latitude) > 90) return;
    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  };

  const visitGeometry = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const geometry = value as { type?: string; coordinates?: unknown; geometries?: unknown };
    if (geometry.type === 'GeometryCollection') {
      if (Array.isArray(geometry.geometries)) geometry.geometries.forEach(visitGeometry);
      return;
    }
    if (geometry.type && Object.hasOwn(coordinateDepth, geometry.type)) {
      visitCoordinates(geometry.coordinates, coordinateDepth[geometry.type]);
    }
  };

  geometries.forEach(visitGeometry);
  return west === Infinity ? null : [[west, south], [east, north]];
}
