export interface User {
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  roleDepartements: string[];
  roleCommunes: string[];
  checkRules: string;
}

export enum UserRole {
  mte = 'MTE',
  departement = 'Département',
  commune = 'Commune',
}
