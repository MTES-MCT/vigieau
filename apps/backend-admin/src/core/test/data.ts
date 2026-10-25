/**
 * Création d'ACs pour les tests
 * 001 en brouillon
 * 002 validé mais pas encore publié
 * 003 publié
 * 004 ACI validé pilote
 * 005 ACI validé pas pilote
 * 006 abrogé
 * 007 en dehors du scope
 */

const testArretesCadre: any[] = [
  {
    numero: 'CYTEST_001',
    statut: 'a_valider',
    dateDebut: '2024-01-01',
    zonesAlerte: [],
    usages: [],
  },
  {
    numero: 'CYTEST_002',
    statut: 'a_venir',
    dateDebut: '2099-01-01',
    usages: [],
  },
  {
    numero: 'CYTEST_003',
    statut: 'publie',
    dateDebut: '2024-01-01',
    usages: [],
  },
  {
    numero: 'CYTEST_004',
    statut: 'a_venir',
    dateDebut: '2024-01-01',
    usages: [],
  },
  {
    numero: 'CYTEST_005',
    statut: 'a_venir',
    dateDebut: '2024-01-01',
    usages: [],
  },
  {
    numero: 'CYTEST_006',
    statut: 'abroge',
    dateDebut: '2024-01-01',
    dateFin: '2024-01-15',
    zonesAlerte: [],
    usages: [],
  },
  {
    numero: 'CYTEST_007',
    statut: 'a_venir',
    dateDebut: '2024-01-01',
    usages: [],
  },
  ...Array.from({ length: 5 }, (_, index) => ({
    numero: `CYTEST_PAGE_${String(index + 1).padStart(3, '0')}`,
    statut: 'publie',
    dateDebut: '2024-01-01',
    zonesAlerte: [],
    usages: [],
  })),
];

export { testArretesCadre };
