import type { Zone } from './zone.dto';

export type WaterType = 'AEP' | 'SUP' | 'SOU';
export type ZoneAvailabilityStatus =
  | 'available'
  | 'confirmed_none'
  | 'unavailable';

export interface ZoneAvailability {
  status: ZoneAvailabilityStatus;
  officialUrl?: string | null;
  asOf?: string | null;
  sourceRevision?: string | null;
}

export type ZoneAvailabilityByType = Record<WaterType, ZoneAvailability>;

export interface ZoneSearchResponse {
  zones: Zone[];
  availability: ZoneAvailabilityByType;
}
