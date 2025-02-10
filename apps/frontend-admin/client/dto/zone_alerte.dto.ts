import type { Departement } from '~/dto/departement.dto';
import type { ArreteCadre } from "~/dto/arrete_cadre.dto";
import type { Commune } from '~/dto/commune.dto';

export interface ZoneAlerte {
  id: number;
  code: string;
  type: 'SUP' | 'SOU';
  ressourceInfluencee: boolean;
  nom: string;
  departement: Departement;
  arretesCadre: ArreteCadre[];
  disabled: boolean;
  
  geom?: any;
  communes: Commune[];
  
  // FRONT ONLY
  communesText: string | undefined;
}
