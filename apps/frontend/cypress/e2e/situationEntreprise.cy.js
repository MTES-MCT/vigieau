/* global cy, describe, it */

import {
  searchSituationFromHome,
  situationZone,
  stubSituationApis,
  visitSituation,
} from '../support/public-situation';

const vigilanceZone = situationZone({
  id: 'vigilance-entreprise',
  niveauGravite: 'vigilance',
});
const restrictionZone = situationZone({
  id: 'restrictions-entreprise',
  niveauGravite: 'crise',
  restrictions: true,
});

function assertEnterpriseSituation() {
  cy.get('body .fr-header').should('exist');
  cy.get('body .situation-status').should('be.visible');
  cy.get('#situation-profile').should('have.value', 'entreprise');
  cy.get('body .gestes').should('not.exist');
  cy.get('body .liens').should('exist');
  cy.get('body .faq').should('exist');
  cy.get('body .fr-footer').should('exist');
}

describe(`Test de l'affichage des situations pour les entreprises`, () => {
  it(`On doit être redirigé si il n'y a pas d'adresse`, () => {
    stubSituationApis(vigilanceZone);
    cy.visit('/situation');
    cy.location('pathname').should('equal', '/');
  });

  describe(`Quand il y a une adresse recherchée`, () => {
    it(`La page doit s'afficher correctement pour un état de vigilance`, () => {
      searchSituationFromHome(vigilanceZone, 'entreprise');
      assertEnterpriseSituation();
      cy.get('.situation-status-header')
        .should('contain.text', 'vigilance')
        .and('contain.text', 'Sensibilisation mais pas de restriction');
      cy.contains('h2', 'Détails des restrictions').should('not.exist');
    });
  });

  describe(`Quand il y a des paramètres dans l'URL`, () => {
    it(`La page doit s'afficher correctement pour un état avec des restrictions`, () => {
      visitSituation(restrictionZone, 'entreprise');
      assertEnterpriseSituation();
      cy.get('.situation-status-header').should('contain.text', 'crise');
      cy.contains('h2', 'Détails des restrictions').should('be.visible');
    });
  });
});
