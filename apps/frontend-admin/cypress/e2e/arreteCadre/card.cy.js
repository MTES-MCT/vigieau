/* global after, before, cy, Cypress, describe, it */

const cases = [
  { numero: 'CYTEST_001', departement: ['Modifier', 'Dupliquer', 'Supprimer'], mte: ['Modifier', 'Dupliquer', 'Supprimer'] },
  { numero: 'CYTEST_002', departement: ['Corriger', 'Supprimer', 'Abroger'], mte: ['Corriger', 'Supprimer', 'Abroger'] },
  { numero: 'CYTEST_003', departement: ['Corriger', 'Supprimer', 'Abroger'], mte: ['Corriger', 'Supprimer', 'Abroger'] },
  { numero: 'CYTEST_004', departement: ['Corriger', 'Supprimer', 'Abroger'], mte: ['Corriger', 'Supprimer', 'Abroger'] },
  { numero: 'CYTEST_005', departement: ['Corriger', 'Supprimer', 'Abroger'], mte: ['Corriger', 'Supprimer', 'Abroger'] },
  { numero: 'CYTEST_006', abroge: true, departement: ['Dupliquer', 'Supprimer'], mte: ['Corriger', 'Dupliquer', 'Supprimer'] },
  { numero: 'CYTEST_007', autreDepartement: true, departement: [], mte: ['Corriger', 'Supprimer', 'Abroger'] },
];
const actions = ['Modifier', 'Corriger', 'Dupliquer', 'Supprimer', 'Abroger'];

describe('Carte des arrêtés cadres', () => {
  before(() => {
    cy.logout();
    cy.populateDb('arrete-cadre');
  });

  after(() => {
    cy.resetDb('arrete-cadre');
  });

  it('Un arrêté cadre doit afficher son numéro, son statut, son département et sa date', () => {
    cy.devLogin(Cypress.env('mteUser'));
    cy.searchAC('CYTEST_001');
    cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1).within(() => {
      cy.get('.fr-card__title').should('contain.text', 'CYTEST_001');
      cy.get('.fr-badge').should('contain.text', 'Brouillon');
      cy.get('.fr-card__desc').should('contain.text', 'Corse-du-Sud');
      cy.get('.fr-card__detail').should('contain.text', '01/01/2024');
    });
  });

  for (const role of ['departement', 'mte']) {
    describe(`Permissions ${role}`, () => {
      for (const fixture of cases) {
        it(`Affiche uniquement les actions autorisées pour ${fixture.numero}`, () => {
          cy.devLogin(Cypress.env(role === 'mte' ? 'mteUser' : 'departementUser'));
          if (fixture.abroge) {
            cy.get('[data-cy=ArreteCadreListFilterAbroge]').first().click();
          }
          cy.searchAC(fixture.numero, true, fixture.autreDepartement && role === 'departement' ? '2B - Haute-Corse' : undefined);
          cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
          const allowedActions = fixture[role];
          if (!allowedActions.length) {
            cy.get('[data-cy=ArreteCadreCardActionsBtn]').should('not.exist');
            return;
          }
          cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
          for (const action of actions) {
            cy.contains('.fr-card__actions__menu li', new RegExp(`^${action}$`))
              .should(allowedActions.includes(action) ? 'exist' : 'not.exist');
          }
        });
      }
    });
  }
});
