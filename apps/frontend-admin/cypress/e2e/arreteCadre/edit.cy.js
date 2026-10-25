/* global after, before, cy, Cypress, describe, it */

describe('Edition d\'un arrêté cadre', () => {
  before(() => {
    cy.populateDb('arrete-cadre');
  });

  after(() => {
    cy.resetDb('arrete-cadre');
  });

  it('Un département peut corriger son arrêté à venir après confirmation', () => {
    cy.devLogin(Cypress.env('departementUser'));
    cy.searchAC('CYTEST_002');
    cy.get('[data-cy=ArreteCadreListCard] .fr-badge').should('contain.text', 'En vigueur prochainement');
    cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
    cy.contains('.fr-card__actions__menu li', /^Corriger$/).click();
    cy.get('dialog[open] .fr-modal__title').should('contain.text', 'Modification d’un arrêté cadre à venir');
    cy.get('[data-cy=ConfirmEditFormBtn]').click();
    cy.get('h1').should('contain.text', "Edition d'un arrêté cadre");
    cy.get('[data-cy=ArreteCadreFormNumeroInput]').should('have.value', 'CYTEST_002');
    cy.get('[data-cy=PublishFormDateDebutInput]').should('have.value', '2099-01-01');
  });
});
