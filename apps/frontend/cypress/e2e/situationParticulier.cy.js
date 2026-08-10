/* global cy, describe, it */

import {
  searchSituationFromHome,
  situationZone,
  stubSituationApis,
  visitSituation,
} from '../support/public-situation';

const restrictionZone = situationZone({
  id: 'restrictions-particulier',
  niveauGravite: 'crise',
  restrictions: true,
});
const vigilanceZone = situationZone({
  id: 'vigilance-particulier',
  departement: '29',
  niveauGravite: 'vigilance',
});

function assertParticularSituation() {
  cy.get('body .fr-header').should('exist');
  cy.get('body .situation-status').should('be.visible');
  cy.get('#situation-profile').should('have.value', 'particulier');
  cy.get('body .gestes').should('exist');
  cy.get('body .liens').should('exist');
  cy.get('body .faq').should('exist');
  cy.get('body .fr-footer').should('exist');
}

describe(`Test de l'affichage des situations pour les particuliers`, () => {
  it(`On doit être redirigé si il n'y a pas d'adresse`, () => {
    stubSituationApis(restrictionZone);
    cy.visit('/situation');
    cy.location('pathname').should('equal', '/');
  });

  describe(`Quand il y a une adresse recherchée`, () => {
    it(`La page doit s'afficher correctement pour un état avec des restrictions`, () => {
      searchSituationFromHome(restrictionZone, 'particulier');
      assertParticularSituation();
      cy.get('.situation-status-header').should('contain.text', 'crise');
      cy.contains('h2', 'Détails des restrictions').should('be.visible');
    });
  });

  describe(`Quand il y a des paramètres dans l'URL`, () => {
    it(`La page doit s'afficher correctement pour un état avec des restrictions`, () => {
      visitSituation(restrictionZone, 'particulier');
      assertParticularSituation();
      cy.get('.situation-status-header').should('contain.text', 'crise');
      cy.contains('h2', 'Détails des restrictions').should('be.visible');
    });

    it(`La page doit s'afficher correctement pour un état sans restrictions`, () => {
      visitSituation(vigilanceZone, 'particulier');
      assertParticularSituation();
      cy.get('.situation-status-header')
        .should('contain.text', 'vigilance')
        .and('contain.text', 'Sensibilisation mais pas de restriction');
      cy.contains('h2', 'Détails des restrictions').should('not.exist');
    });
  });
});
