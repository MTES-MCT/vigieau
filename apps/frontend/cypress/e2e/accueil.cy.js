/* global beforeEach, cy, describe, it */

function stubHomeMap() {
  cy.intercept('GET', '**/zones/publication', {
    statusCode: 503,
    body: { message: 'Publication indisponible pendant le test' },
  });
  cy.intercept(
    'GET',
    'https://openmaptiles.data.gouv.fr/styles/osm-bright/style.json',
    { statusCode: 200, body: { version: 8, sources: {}, layers: [] } },
  );
  cy.intercept('HEAD', '**/*.pmtiles*', { statusCode: 503, body: '' });
}

describe('Test de la home page', () => {
  beforeEach(() => {
    stubHomeMap();
    cy.visit('/');
  });

  it(`Nous devons bien arriver sur la page d'accueil`, () => {
    cy.visit('/');
    cy.location('pathname').should('equal', '/');
  });

  it(`La page doit s'afficher correctement`, () => {
    cy.get('body .fr-header').should('exist');
    cy.get('body .presentation').should('exist');
    cy.get('body .gestes').should('exist');
    cy.get('body .liens').should('exist');
    cy.get('body .faq').should('exist');
    cy.get('body .fr-footer').should('exist');
  });

  describe(`Header`, () => {
    it(`Le header doit s'afficher correctement`, () => {
      cy.get('body .fr-header').should('exist');
      cy.get('body .fr-header .fr-logo')
        .should('contain.text', 'République')
        .and('contain.text', 'Française');
    });
  });

  describe(`Footer`, () => {
    it(`Le footer doit s'afficher correctement`, () => {
      cy.get('body .fr-footer').should('exist');
      cy.get('body .fr-footer .fr-logo')
        .should('contain.text', 'République')
        .and('contain.text', 'Française');
      cy.get('body .fr-footer .fr-footer__content-list')
        .find('li')
        .should('have.length', 4);
      cy.get('body .fr-footer .fr-footer__bottom-list')
        .find('li')
        .should('have.length', 4);
    });

    it(`On doit pouvoir accéder aux pages légales depuis le footer`, () => {
      const legalRoutes = [
        '/accessibilite',
        '/mentions-legales',
        '/donnees-personnelles',
        '/cookies',
      ];

      for (const route of legalRoutes) {
        cy.get(`body .fr-footer a[href="${route}"]`).click();
        cy.location('pathname').should('equal', route);
      }
    });
  });

  describe(`Bloc présentation`, () => {
    it(`Le bloc présentation doit s'afficher correctement`, () => {
      cy.get('body .presentation #main-search-profile').should('exist');
      cy.get('body .presentation #main-search-water-type').should('exist');
      cy.get('body .presentation #main-search-address').should('exist');
      cy.get('body .presentation [data-cy=MainRestrictionSearchSubmit]')
        .should('exist');
    });
  });
});
