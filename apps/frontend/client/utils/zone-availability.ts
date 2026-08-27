import type { Zone } from '../dto/zone.dto';
import type {
  WaterType,
  ZoneAvailability,
  ZoneAvailabilityByType,
  ZoneAvailabilityStatus,
  ZoneSearchResponse,
} from '../dto/zone-availability.dto';

const waterTypes: WaterType[] = ['AEP', 'SUP', 'SOU'];
const validStatuses: ZoneAvailabilityStatus[] = [
  'available',
  'confirmed_none',
  'unavailable',
];
const validFreshness = ['current', 'updating'] as const;

export type ZoneSituationState =
  'restricted' | 'municipal' | 'confirmed_none' | 'unavailable';

const officialDepartmentUrls: Record<string, string> = {
  '49': 'https://www.maine-et-loire.gouv.fr/Actions-de-l-Etat/Eau-et-Environnement/Eau-et-milieux-aquatiques/Les-restrictions-en-eau-liees-a-la-secheresse',
  '79': 'https://www.deux-sevres.gouv.fr/Publications/Annonces-et-avis/Arretes-de-restriction-d-eau-prelevee-a-partir-du-reseau-d-eau-potable',
};

const isZone = (value: unknown): value is Zone => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<Zone>;
  return (
    (candidate.id === null ||
      typeof candidate.id === 'string' ||
      typeof candidate.id === 'number') &&
    waterTypes.includes(candidate.type as WaterType)
  );
};

const safeOfficialUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

export const getOfficialDepartmentUrl = (
  departmentCode?: string | null,
): string | null =>
  departmentCode ? (officialDepartmentUrls[departmentCode] ?? null) : null;

export const getZoneSituationState = (
  zone: Zone | null | undefined,
  availability: ZoneAvailability,
): ZoneSituationState => {
  if (zone?.arreteMunicipalCheminFichier) {
    return 'municipal';
  }
  if (availability.status === 'unavailable') {
    return 'unavailable';
  }
  if (availability.status === 'confirmed_none') {
    return 'confirmed_none';
  }
  return zone?.id !== null && zone?.id !== undefined
    ? 'restricted'
    : 'unavailable';
};

const inferAvailability = (
  zones: Zone[],
  type: WaterType,
  departmentCode?: string | null,
): ZoneAvailability => {
  if (
    zones.some(
      (zone) =>
        zone.type === type &&
        (zone.id !== null || Boolean(zone.arreteMunicipalCheminFichier)),
    )
  ) {
    return { status: 'available' };
  }

  return {
    status: 'unavailable',
    officialUrl:
      type === 'AEP' ? getOfficialDepartmentUrl(departmentCode) : null,
  };
};

const normalizeOptionalString = (value: unknown): string | null | undefined =>
  value === null || typeof value === 'string' ? value : undefined;

const normalizeAvailability = (
  value: unknown,
  fallback: ZoneAvailability,
): ZoneAvailability => {
  const candidate =
    typeof value === 'string'
      ? { status: value }
      : value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : null;
  const status = candidate?.status;
  if (!validStatuses.includes(status as ZoneAvailabilityStatus)) {
    return fallback;
  }

  return {
    status: status as ZoneAvailabilityStatus,
    officialUrl:
      safeOfficialUrl(candidate?.officialUrl) ?? fallback.officialUrl,
    asOf: normalizeOptionalString(candidate?.asOf),
    sourceRevision: normalizeOptionalString(candidate?.sourceRevision),
    freshness: validFreshness.includes(
      candidate?.freshness as (typeof validFreshness)[number],
    )
      ? (candidate?.freshness as (typeof validFreshness)[number])
      : fallback.freshness,
    pendingSince: normalizeOptionalString(candidate?.pendingSince),
  };
};

export const formatZoneAvailabilityDate = (
  value?: string | null,
): string | null => {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'long',
    timeZone: 'Europe/Paris',
  }).format(date);
};

export const normalizeZoneSearchResponse = (
  value: unknown,
  departmentCode?: string | null,
): ZoneSearchResponse => {
  const isLegacyResponse = Array.isArray(value);
  const candidate =
    !isLegacyResponse && value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null;
  const rawZones = isLegacyResponse ? value : candidate?.zones;
  const zones = Array.isArray(rawZones) ? rawZones.filter(isZone) : [];
  const resolvedDepartmentCode =
    departmentCode ?? zones[0]?.departement ?? null;
  const rawAvailability = candidate?.availability;
  const availabilityObject =
    rawAvailability && typeof rawAvailability === 'object'
      ? (rawAvailability as Record<string, unknown>)
      : {};

  const availability = Object.fromEntries(
    waterTypes.map((type) => {
      const fallback = inferAvailability(zones, type, resolvedDepartmentCode);
      return [type, normalizeAvailability(availabilityObject[type], fallback)];
    }),
  ) as ZoneAvailabilityByType;

  return {
    zones,
    availability,
  };
};

export const getDepartmentCodeFromCommune = (
  communeCode?: string | null,
): string | null => {
  if (!communeCode) {
    return null;
  }
  if (/^(?:97|98)\d/.test(communeCode)) {
    return communeCode.slice(0, 3);
  }
  if (/^2[AB]/i.test(communeCode)) {
    return communeCode.slice(0, 2).toUpperCase();
  }
  return communeCode.slice(0, 2);
};

export const isUnsupportedZoneV2Status = (status?: number): boolean =>
  status === 400 || status === 404 || status === 405 || status === 501;
