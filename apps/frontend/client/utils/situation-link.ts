import type { Address } from '../dto/address.dto';
import type { Geo } from '../dto/geo.dto';

const communeCodePattern = /^(?:\d{5}|2[AB]\d{3})$/;
const coordinatePattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

export type SituationPoint =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'point'; address: Address };

function coordinate(value: unknown, limit: number): number | null {
  if (typeof value !== 'string' || !coordinatePattern.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

export function parseSituationPoint(query: Record<string, unknown>): SituationPoint {
  if (!('lon' in query) && !('lat' in query)) return { kind: 'absent' };
  const lon = coordinate(query.lon, 180);
  const lat = coordinate(query.lat, 90);
  if (lon === null || lat === null) return { kind: 'invalid' };

  const citycode = typeof query.commune === 'string' && communeCodePattern.test(query.commune)
    ? query.commune
    : '';
  const label = typeof query.adresse === 'string' && query.adresse.trim()
    ? query.adresse.trim().slice(0, 500)
    : `Point sur la carte (${lat}, ${lon})`;
  return {
    kind: 'point',
    address: {
      geometry: { coordinates: [lon, lat] },
      properties: { type: 'point', label, citycode, postcode: '', context: '' },
    },
  };
}

export function buildSituationQuery(
  address: Address | null,
  geo: Geo | null,
  profile: string,
  typeEau: string,
): Record<string, string> {
  const query: Record<string, string> = {
    profil: profile,
    typeEau,
    adresse: address ? address.properties.label : `${geo?.nom}, ${geo?.codeDepartement}`,
  };
  if (address?.properties.type === 'point') {
    const [lon, lat] = address.geometry.coordinates;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180 || !Number.isFinite(lat) || Math.abs(lat) > 90) {
      throw new Error('Invalid point coordinates');
    }
    query.lon = String(lon);
    query.lat = String(lat);
    if (communeCodePattern.test(address.properties.citycode)) query.commune = address.properties.citycode;
  }
  return query;
}
