/* global cy, describe, it */

const levels = { vigilance: 1, alerte: 2, alerte_renforcee: 3, crise: 4 };
const row = (date) => ({ date, AEP: levels, ESU: levels, ESO: levels });
const notice = () => cy.contains('Données historiques sur l’eau potable limitées');

describe('Historique de la surface en eau potable', () => {
  it('affiche la limite du 28 avril uniquement pour la série calculée et le type concerné', () => {
    cy.clock(Date.UTC(2026, 10, 19, 12), ['Date']);
    cy.intercept('GET', '**/data', { body: { departements: [], regions: [], bassinsVersants: [] } });
    cy.intercept('GET', '**/data/status', { statusCode: 404, body: {} });
    cy.intercept('GET', '**/zones/publication', { statusCode: 503, body: {} });
    cy.intercept('GET', '**/data/area?*', ({ query, reply }) => {
      reply({ body: [row(query.dateDebut), row(query.dateFin)] });
    }).as('observations');
    cy.visit('/donnees/surface');
    cy.wait('@observations');
    cy.get('#area-restrictions-history-table').should('be.visible');
    notice().should('not.exist');

    cy.get('#dateDebut').clear().type('2024-04-26');
    cy.get('#dateFin').clear().type('2024-04-27');
    notice().should('not.exist');
    cy.contains('button', 'Calculer').click();
    cy.wait('@observations');
    notice().should('be.visible');

    cy.get('#dateFin').clear().type('2024-04-29');
    cy.contains('button', 'Calculer').click();
    cy.wait('@observations');
    notice().should('be.visible');
    cy.contains('label', "Type d'eau").invoke('attr', 'for').then((id) => {
      cy.get(`[id="${id}"]`).select('ESU');
      notice().should('not.exist');
      cy.get(`[id="${id}"]`).select('AEP');
      notice().should('be.visible');
    });

    cy.get('#dateDebut').clear().type('2024-04-28');
    cy.contains('button', 'Calculer').click();
    cy.wait('@observations');
    notice().should('not.exist');
  });
});
