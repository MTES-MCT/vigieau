import type { Thematique } from '~/dto/thematique.dto';

export class Usage {
  id: number | null;
  nom: string | null;
  thematique: Thematique | null;
  isTemplate: boolean;
  concerneParticulier: boolean;
  concerneCollectivite: boolean;
  concerneExploitation: boolean;
  concerneEntreprise: boolean;
  concerneEso: boolean;
  concerneEsu: boolean;
  concerneAep: boolean;
  descriptionVigilance: string | null;
  descriptionAlerte: string | null;
  descriptionAlerteRenforcee: string | null;
  descriptionCrise: string | null;

  // Frontend only
  isAlreadyUsed: boolean;
  display: any;

  constructor(usage?: Usage) {
    this.id = null;
    this.nom = usage ? usage.nom : null;
    this.thematique = usage ? usage.thematique : null;
    this.concerneParticulier = usage ? usage.concerneParticulier : false;
    this.concerneEntreprise = usage ? usage.concerneEntreprise : false;
    this.concerneCollectivite = usage ? usage.concerneCollectivite : false;
    this.concerneExploitation = usage ? usage.concerneExploitation : false;
    this.concerneEso = usage ? usage.concerneEso : true;
    this.concerneEsu = usage ? usage.concerneEsu : true;
    this.concerneAep = usage ? usage.concerneAep : true;
    this.descriptionVigilance = usage ? usage.descriptionVigilance : null;
    this.descriptionAlerte = usage ? usage.descriptionAlerte : null;
    this.descriptionAlerteRenforcee = usage ? usage.descriptionAlerteRenforcee : null;
    this.descriptionCrise = usage ? usage.descriptionCrise : null;
  }
}
