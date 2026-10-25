/* global after, before, cy, Cypress, describe, expect, it */

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
      cy.wrap(card).find('.fr-card__desc').should('contain.text', 'Corse-du-Sud');
    })

    cy.searchAC('CYTEST_007', false);
    cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 0);
  });

  it(`Un utilisateur MTE doit pouvoir voir et accéder à tout les arrêtés cadres`, () => {
    cy.devLogin(Cypress.env('mteUser'));
    cy.url().should('match', /arrete-cadre/);
    cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 9);
    cy.get('.fr-pagination [title="Page 1"]').should('have.attr', 'aria-current', 'page');
    cy.get('.fr-pagination [title="Page 2"]').should('exist');
    cy.get('[data-cy=ArreteCadreListCard] .fr-card__title').then(($titles) => {
      const firstPage = [...$titles].map((title) => title.textContent.trim());
      cy.intercept('GET', '**/api/arrete-cadre/search*').as('nextPage');
      cy.get('.fr-pagination__link--next').click();
      cy.wait('@nextPage').its('response.body.meta').should('include', { totalItems: 11, totalPages: 2, currentPage: 2 });
      cy.get('[data-cy=ArreteCadreListCard]').should('have.length', 2);
      cy.get('[data-cy=ArreteCadreListCard] .fr-card__title').each(($title) => {
        expect(firstPage).not.to.include($title.text().trim());
      });
      cy.get('.fr-pagination__link--prev').click();
      cy.wait('@nextPage').then(({ request }) => {
        expect(new URL(request.url).searchParams.get('page')).to.equal('1');
      });
      cy.get('.fr-pagination [title="Page 1"]').should('have.attr', 'aria-current', 'page');
      cy.get('[data-cy=ArreteCadreListCard] .fr-card__title').should(($firstPage) => {
        expect([...$firstPage].map((title) => title.textContent.trim())).to.deep.equal(firstPage);
      });
    });

    cy.searchAC('CYTEST_007');
    cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
  });
});
