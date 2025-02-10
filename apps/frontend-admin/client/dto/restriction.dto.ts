export class Restriction {
  id: number | null;
  isAep: boolean;
  zoneAlerte: any;
  arreteCadre: any;
  communes: any[] | null;
  nomGroupementAep: string | null;
  niveauGravite: 'vigilance' | 'alerte' | 'alerte_renforcee' | 'crise' | null;
  usages: any[];
  
  communesText: string | undefined;

  constructor(isAep = false) {
    this.id = null;
    this.isAep = isAep;
    this.zoneAlerte = isAep ? null : [];
    this.arreteCadre = null;
    this.communes = isAep ? [] : null;
    this.nomGroupementAep = null;
    this.niveauGravite = null;
    this.usages = [];
  }

}

export enum RestrictionNiveauGraviteFr {
  pas_restrictions = 'Pas de restrictions',
  vigilance = 'Vigilance',
  alerte = 'Alerte',
  alerte_renforcee = 'Alerte renforcée',
  crise = 'Crise',
}