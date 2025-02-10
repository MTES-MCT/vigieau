import type { Commune } from '~/dto/commune.dto';
import type { User } from '~/dto/user.dto';

export class ArreteMunicipal {
  id: number | null;
  userFirstName: string | null;
  userLastName: string | null;
  userEmail: string | null;
  userPhone: string | null;
  dateDebut: string | null;
  dateFin: string | null;
  statut: 'a_valider' | 'a_venir' | 'publie' | 'abroge';
  fichier: any;
  communes: Commune[];

  // To upload file
  file: any;

  constructor(user: User) {
    this.communes = [];
    this.id = null;
    this.userEmail = user ? user.email : null;
    this.userFirstName = user ? user.firstName : null;
    this.userLastName = user ? user.lastName : null;
    this.userPhone = null;
    this.dateDebut = null;
    this.dateFin = null;
    this.statut = 'a_valider';
    this.fichier = null;
  }
}
