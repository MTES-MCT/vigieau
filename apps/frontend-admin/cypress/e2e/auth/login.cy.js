describe('Test de la page de Login', () => {
  beforeEach(() => {
    cy.logout();
  });

  it(`Nous devons être redirigé vers la page de login`, () => {
    cy.visit('/');
    cy.location('pathname').should('equal', '/connexion');
  });

  describe('Login de dev', () => {
    it(`Le bouton "connecté" doit être disabled si aucun utilisateur n'est sélectionné`, () => {
      cy.get('[data-cy=LoginDevBtn]').should('be.disabled');
    });

    it('Test du login', () => {
      cy.get('.fr-select').should('exist');
      cy.get('.fr-select').select(1);
      cy.get('[data-cy=LoginDevBtn]').should('not.be.disabled');
      cy.get('[data-cy=LoginDevBtn]').click();
      cy.url().should('include', '/arrete-cadre');

      describe('La page de login ne doit plus être accessible', () => {
        cy.visit('/connexion');
        cy.url().should('include', '/arrete-cadre');
      });
    });
  });

  describe('Login AgentConenect', () => {
    it(`Le bouton AgentConenct doit être visible`, () => {
      cy.get('[data-cy=LoginAgentConnectBtn]').should('exist');
    });    
  });
});