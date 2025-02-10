import type { Departement } from "~/dto/departement.dto";

export class Parametres {
  superpositionCommune: string | null;
  departement: Departement | undefined;
  
  constructor() {
    this.superpositionCommune = null;
  }
}
