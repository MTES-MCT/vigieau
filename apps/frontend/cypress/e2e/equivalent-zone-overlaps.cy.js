/* global cy, describe, expect, it */

const publicationId = '29959a00-0000-4000-8000-000000000000';
const addressFeature = {
  type: 'Feature',
  geometry: { coordinates: [3.16, 43.6154] },
  properties: {
    id: '34028_test_00001',
    type: 'housenumber',
    label: 'Adresse de test dans l’Hérault',
    postcode: '34600',
    citycode: '34028',
    context: '34, Hérault, Occitanie',
  },
};

const zone = (id, type, nom) => ({
  id,
  type,
  nom,
  departement: '34',
  niveauGravite: 'vigilance',
  ressourceInfluencee: false,
  arrete: {
    id: 38231,
    dateDebutValidite: '2026-10-10T00:00:00.000Z',
    dateFinValidite: '2026-12-31T00:00:00.000Z',
    cheminFichier: 'https://example.test/restriction.pdf',
    cheminFichierArreteCadre: 'https://example.test/cadre.pdf',
  },
  usages: [{
    id: id * 10,
    nom: 'Arrosage',
    thematique: 'Arroser',
    description: 'Sensibiliser les usagers.',
    concerneParticulier: true,
    concerneEntreprise: true,
    concerneCollectivite: true,
    concerneExploitation: true,
  }],
});

const zones = [
  zone(7260843, 'SUP', 'Orb hors axe soutenu'),
  zone(7260839, 'SUP', 'Axe Orb soutenu'),
  zone(7260844, 'SOU', 'Nappe amont'),
  zone(7260840, 'SOU', 'Nappe aval'),
];

describe('Consultation des zones équivalentes avec identifiants numériques', () => {
  for (const useV2 of [true, false]) {
    it(`permet de choisir et changer de ressource avec la réponse ${useV2 ? 'V2' : 'V1 de repli'}`, () => {
      cy.viewport(320, 800);
      cy.intercept('GET', '**/search/?q=*', {
        statusCode: 200,
        body: { type: 'FeatureCollection', features: [addressFeature] },
      }).as('addressSearch');
      cy.intercept('GET', '**/zones/publication', {
        statusCode: 200,
        body: {
          id: publicationId,
          revision: '480',
          pmtilesUrl: 'https://example.test/zones/480.pmtiles',
          pmtilesChecksum: 'a'.repeat(64),
        },
      });
      cy.intercept('GET', '**/zones/v2?*', {
        statusCode: useV2 ? 200 : 404,
        body: useV2 ? {
          zones,
          availability: {
            SUP: { status: 'available' },
            SOU: { status: 'available' },
            AEP: { status: 'unavailable' },
          },
        } : {},
      }).as('zoneSearchV2');
      cy.intercept('GET', '**/zones?*', {
        statusCode: 200,
        body: zones,
      }).as('zoneSearchV1');

      cy.visit('/situation?adresse=Adresse+de+test+Herault&profil=particulier&typeEau=SUP');
      cy.wait('@zoneSearchV2').then(({ request, response }) => {
        expect(new URL(request.url).searchParams.get('publicationId')).to.equal(publicationId);
        expect(response.statusCode).to.equal(useV2 ? 200 : 404);
        if (useV2) expect(response.body.zones[0].id).to.equal(7260843);
      });
      if (useV2) {
        cy.get('@zoneSearchV1.all').should('have.length', 0);
      } else {
        cy.wait('@zoneSearchV1').its('response.body.0.id').should('equal', 7260843);
      }

      cy.get('dialog[open]').should('have.length', 1);
      cy.get('#situation-alert-zone-modal').select('7260843');
      cy.get('dialog[open]').contains('button', 'Valider').click();
      cy.get('dialog[open]').should('not.exist');
      cy.get('#situation-alert-zone').should('have.value', '7260843');
      cy.get('.situation-status-header h1').should('contain.text', 'vigilance');
      cy.get('.situation-status-header h1').should('not.contain.text', 'ne peuvent pas être confirmées');

      cy.get('#situation-alert-zone').select('7260839').should('have.value', '7260839');
      cy.get('#situation-update-status').should('contain.text', 'Axe Orb soutenu');
      cy.get('.situation-status-header h1').should('contain.text', 'vigilance');

      cy.get('#situation-water-type').select('SOU');
      cy.get('dialog[open]').should('have.length', 1);
      cy.get('#situation-alert-zone-modal').select('7260840');
      cy.get('dialog[open]').contains('button', 'Valider').click();
      cy.get('dialog[open]').should('not.exist');
      cy.get('#situation-alert-zone').should('have.value', '7260840');
      cy.get('.situation-status-header h1').should('contain.text', 'nappes');
      cy.get('.situation-status-header h1').should('contain.text', 'vigilance');
      cy.get('#situation-profile').select('entreprise');
      cy.get('#situation-alert-zone').should('have.value', '7260840');
      cy.get('#situation-alert-zone option:selected').should('have.text', 'Nappe aval');
      cy.location('pathname').should('equal', '/situation');
    });
  }
});
