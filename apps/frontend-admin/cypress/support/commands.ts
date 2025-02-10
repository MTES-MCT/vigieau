import axios from "axios";

Cypress.Commands.add('logout', () => {
  cy.clearAllLocalStorage();
  cy.clearAllCookies();
  cy.visit('/');
  cy.url().should('match', /connexion/);
});

Cypress.Commands.add('devLogin', (email) => {
  cy.logout();
  if(email) {
    cy.get('.fr-select').select(email);
  } else {
    cy.get('.fr-select').select(1);
    
  }
  cy.get('[data-cy=LoginDevBtn]').click();
  cy.url().should('match', /arrete-cadre/);
});

Cypress.Commands.add('searchAC', (numero: string, exist: boolean = true, selectDepartement?: string) => {
  if(selectDepartement) {
    cy.intercept({
      method: 'GET',
      url: '/api/arrete-cadre/search*',
    }).as('acSearchSelect');
    cy.get('.fr-select').select(selectDepartement);
    cy.wait('@acSearchSelect');
  }
  cy.get('[data-cy=ArreteCadreListSearchBar] input').clear();
  cy.intercept({
    method: 'GET',
    url: '/api/arrete-cadre/search*',
  }).as('acSearch');
  cy.get('[data-cy=ArreteCadreListSearchBar] input').type(numero);
  cy.wait('@acSearch');
  if(exist) {
    cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard] .fr-card__title').contains(numero).should('exist');
  } else {
    cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard] .fr-card__title').should('not.exist');
  }
});

Cypress.Commands.add('populateDb', async (endpoint) => {
  await axios.post(`${Cypress.env('apiUrl')}/${endpoint}/populateTestData`);
});

Cypress.Commands.add('resetDb', async (endpoint) => {
  await axios.post(`${Cypress.env('apiUrl')}/${endpoint}/clearTestData`);
});