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
    dateDebut: '01/01/2024',
    usages: [],
  },
  {
    numero: 'CYTEST_002',
    statut: 'a_venir',
    dateDebut: '01/01/2099',
    usages: [],
  },
  {
    numero: 'CYTEST_003',
    statut: 'publie',
    dateDebut: '01/01/2024',
    usages: [],
  },
  {
    numero: 'CYTEST_004',
    statut: 'a_venir',
    dateDebut: '01/01/2024',
    usages: [],
  },
  {
    numero: 'CYTEST_005',
    statut: 'a_venir',
    dateDebut: '01/01/2024',
    usages: [],
  },
  {
    numero: 'CYTEST_006',
    statut: 'abroge',
    dateDebut: '01/01/2024',
    dateFin: '15/01/2024',
    usages: [],
  },
  {
    numero: 'CYTEST_007',
    statut: 'a_venir',
    dateDebut: '01/01/2024',
    usages: [],
  },
];

export { testArretesCadre };
