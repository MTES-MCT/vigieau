/* global beforeEach, cy, describe, it */

describe('Test du logout', () => {
  beforeEach(() => {
    cy.logout();
  });

  it(`Nous devons être redirigé vers la page de login, le menu du header ne doit pas être visible`, () => {
    cy.visit('/');
    cy.location('pathname').should('equal', '/connexion');
    cy.get('header.fr-header').should('exist');
    cy.get('header.fr-header nav').should('not.be.visible');
    cy.get('header.fr-header a[href="/arrete-cadre"]').should('not.exist');
    cy.get('header.fr-header a[href="/arrete-restriction"]').should('not.exist');
  });

  it(`Au login, le header avec son menu doit être visible avec la possibilité de se déconnecter`, () => {
    cy.devLogin();
    cy.get('header.fr-header').should('exist');
    cy.get('header.fr-header a[href="/arrete-cadre"]').filter(':visible').should('have.length', 1);
    cy.get('header.fr-header a[href="/arrete-restriction"]').filter(':visible').should('have.length', 1);
    // cy.get("header.fr-header nav").contains('Déconnexion').click();
    // Redirection URL AgentConnect fait bug le code-coverage car URL externe
    cy.logout();
    cy.visit('/arrete-cadre');
    cy.url().should('include', '/connexion');
  });
});
