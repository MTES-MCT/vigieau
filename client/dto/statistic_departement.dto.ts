import type { Departement } from '~/dto/departement.dto';

export interface StatisticDepartement {
  id: number;
  departement: Departement;
  visits: any[];
  totalVisits: number;
  weekVisits: number;
  monthVisits: number;
  yearVisits: number;
  subscriptions: number;
  zones: {
    pasRestriction: number;
    vigilance: number;
    alerte: number;
    alerteRenforcee: number;
    crise: number;
  }
}
