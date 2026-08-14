/* global cy, describe, it */

describe("Fil d'Ariane", () => {
  it("place le focus sur le lien Accueil après l'ouverture mobile", () => {
    cy.viewport(320, 800);
    cy.visit('/accessibilite');

    cy.get('.fr-breadcrumb__button')
      .should('be.visible')
      .focus()
      .type('{enter}');

    cy.get('.fr-breadcrumb__button').should('not.exist');
    cy.get('.fr-breadcrumb__link')
      .first()
      .should('have.text', 'Accueil')
      .and('have.attr', 'href', '/')
      .and('be.focused');
  });
});
