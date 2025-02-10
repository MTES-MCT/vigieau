import type { Usage } from '~/dto/usage.dto';
import type { Thematique } from '~/dto/thematique.dto';

export class UsageArreteCadre {
  id: number | null;
  usage: Usage;
  nom: string;
  thematique: Thematique | null;
  concerneParticulier: boolean;
  concerneEntreprise: boolean;
  concerneCollectivite: boolean;
  concerneExploitation: boolean;
  concerneEso: boolean;
  concerneEsu: boolean;
  concerneAep: boolean;
  descriptionVigilance: string;
  descriptionAlerte: string;
  descriptionAlerteRenforcee: string;
  descriptionCrise: string;

  constructor(usage: Usage) {
    this.id = null;
    this.usage = usage;
    this.nom = '';
    this.thematique = null;
    this.concerneParticulier = usage.concerneParticulier;
    this.concerneEntreprise = usage.concerneEntreprise;
    this.concerneCollectivite = usage.concerneCollectivite;
    this.concerneExploitation = usage.concerneExploitation;
    this.concerneEso = usage.concerneEso;
    this.concerneEsu = usage.concerneEsu;
    this.concerneAep = usage.concerneAep;
    this.descriptionVigilance = usage.descriptionVigilance;
    this.descriptionAlerte = usage.descriptionAlerte;
    this.descriptionAlerteRenforcee = usage.descriptionAlerteRenforcee;
    this.descriptionCrise = usage.descriptionCrise;
  }
}
