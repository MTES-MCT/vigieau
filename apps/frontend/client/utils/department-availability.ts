import type {
  DepartementSituation,
  RestrictionLevel,
} from '../dto/departement.dto';
import type { ZoneAvailability } from '../dto/zone-availability.dto';

const officialDepartmentUrls: Readonly<Record<string, string>> = Object.freeze({
  '49': 'https://www.maine-et-loire.gouv.fr/Actions-de-l-Etat/Eau-et-Environnement/Eau-et-milieux-aquatiques/Les-restrictions-en-eau-liees-a-la-secheresse',
  '79': 'https://www.deux-sevres.gouv.fr/Publications/Annonces-et-avis/Arretes-de-restriction-d-eau-prelevee-a-partir-du-reseau-d-eau-potable',
});

const restrictionLevels: RestrictionLevel[] = [
  'vigilance',
  'alerte',
  'alerte_renforcee',
  'crise',
];

export type DepartmentAepSituation =
  | {
      status: 'restricted';
      level: RestrictionLevel;
      officialUrl: string | null;
    }
  | {
      status: 'confirmed_none' | 'unavailable';
      level: null;
      officialUrl: string | null;
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

const getRestrictionLevel = (value: unknown): RestrictionLevel | null =>
  restrictionLevels.includes(value as RestrictionLevel)
    ? (value as RestrictionLevel)
    : null;

const getOfficialDepartmentUrl = (departmentCode: string): string | null =>
  officialDepartmentUrls[departmentCode] ?? null;

const getRawAepAvailability = (
  department: DepartementSituation,
): { present: boolean; value: unknown } => {
  if (!Object.prototype.hasOwnProperty.call(department, 'availability')) {
    return { present: false, value: undefined };
  }
  const availability = department.availability;
  if (!availability || typeof availability !== 'object') {
    return { present: true, value: undefined };
  }
  return {
    present: true,
    value: (availability as Record<string, unknown>).AEP,
  };
};

export const getDepartmentAepSituation = (
  department: DepartementSituation,
): DepartmentAepSituation => {
  const level = getRestrictionLevel(department.niveauGraviteAepMax);
  const fallbackOfficialUrl = getOfficialDepartmentUrl(department.code);
  const raw = getRawAepAvailability(department);

  // An absent contract means that an older backend answered. Existing AEP
  // restrictions remain usable, but an empty value is not proof of absence.
  if (!raw.present) {
    return level
      ? { status: 'restricted', level, officialUrl: fallbackOfficialUrl }
      : {
          status: 'unavailable',
          level: null,
          officialUrl: fallbackOfficialUrl,
        };
  }

  const availability =
    raw.value && typeof raw.value === 'object'
      ? (raw.value as Partial<ZoneAvailability>)
      : null;
  const officialUrl =
    safeOfficialUrl(availability?.officialUrl) ?? fallbackOfficialUrl;

  if (availability?.status === 'confirmed_none') {
    return { status: 'confirmed_none', level: null, officialUrl };
  }
  if (availability?.status === 'available' && level) {
    return { status: 'restricted', level, officialUrl };
  }
  return { status: 'unavailable', level: null, officialUrl };
};
