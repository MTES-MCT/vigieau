/* global cy, describe, expect, it */

const zonePublication = {
  id: '29959a00-0000-4000-8000-000000000000',
  revision: '42',
  pmtilesUrl: 'https://example.test/zones/42.pmtiles',
  pmtilesChecksum: 'a'.repeat(64),
};

describe('Carte des restrictions', () => {
  it('demande le manifeste et sa source de zones dès le premier affichage', () => {
    cy.intercept('GET', '**/zones/publication', {
      statusCode: 200,
      body: zonePublication,
    }).as('zonePublication');
    cy.intercept(
      'GET',
      'https://openmaptiles.data.gouv.fr/styles/osm-bright/style.json',
      { statusCode: 200, body: { version: 8, sources: {}, layers: [] } },
    );
    cy.intercept(
      'GET',
      '**/data/decoupage-administratif.json',
      {
        statusCode: 200,
        body: {
          tilejson: '3.0.0',
          tiles: [],
        },
      },
    );
    cy.intercept('GET', 'https://example.test/zones/42.pmtiles*', {
      statusCode: 503,
      body: 'Archive cartographique simulée',
    }).as('zonesPmtiles');
    cy.intercept('GET', '**/departements?*', {
      statusCode: 200,
      body: [],
    });

    cy.visit('/carte/');

    cy.wait('@zonePublication').its('response.statusCode').should('equal', 200);
    cy.get('.maplibregl-canvas', { timeout: 15000 })
      .should('be.visible')
      .and(($canvas) => {
        expect($canvas[0].width).to.be.greaterThan(0);
        expect($canvas[0].height).to.be.greaterThan(0);
      });
    cy.wait('@zonesPmtiles', { timeout: 15000 })
      .its('request.url')
      .should('include', zonePublication.pmtilesUrl);
  });
});
