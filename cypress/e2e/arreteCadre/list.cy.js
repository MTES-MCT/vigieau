describe('Liste des arrêtés cadres', () => {
  before(() => {
    cy.logout();
    cy.populateDb('arrete-cadre');
  });

  after(() => {
    cy.resetDb('arrete-cadre');
  });

  it(`Un utilisateur DEPARTEMENT doit pouvoir voir et accéder aux arrêtés cadres de son département par défaut`, () => {
    cy.devLogin(Cypress.env('departementUser'));
    cy.url().should('match', /arrete-cadre/);
    cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('exist');
    cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').each(card => {
      cy.wrap(card).get('.fr-card__desc').contains('Corse-du-Sud');
    })

    cy.searchAC('CYTEST_007', false);
    cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 0);
  });

  it(`Un utilisateur MTE doit pouvoir voir et accéder à tout les arrêtés cadres`, () => {
    cy.devLogin(Cypress.env('mteUser'));
    cy.url().should('match', /arrete-cadre/);
    cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 9);
    cy.get('.fr-pagination .fr-pagination__list li').should('have.length', 10);

    cy.searchAC('CYTEST_007');
    cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
  });
});