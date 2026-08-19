import type { ZoneAvailability } from './zone-availability.dto';

export interface Departement {
  id: number;
  code: string;
  nom: string;
}

export type RestrictionLevel =
  | 'vigilance'
  | 'alerte'
  | 'alerte_renforcee'
  | 'crise';

export interface DepartementSituation {
  code: string;
  nom: string;
  region?: string | null;
  niveauGraviteMax?: RestrictionLevel | null;
  niveauGraviteSupMax?: RestrictionLevel | null;
  niveauGraviteSouMax?: RestrictionLevel | null;
  niveauGraviteAepMax?: RestrictionLevel | null;
  availability?: {
    AEP?: ZoneAvailability;
  } | null;
}
