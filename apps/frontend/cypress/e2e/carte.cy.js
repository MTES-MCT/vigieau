describe('Carte des restrictions', () => {
  it('charge les zones dès le premier affichage', () => {
    cy.intercept(
      'GET',
      '**/data/decoupage-administratif.json',
      {
        delay: 20000,
        statusCode: 200,
        body: {
          tilejson: '3.0.0',
          tiles: [],
        },
      },
    );
    cy.intercept('GET', '**/zones_arretes_en_vigueur*.pmtiles*').as(
      'zonesPmtiles',
    );

    cy.visit('/carte/');

    cy.get('.maplibregl-canvas', { timeout: 15000 })
      .should('be.visible')
      .and(($canvas) => {
        expect($canvas[0].width).to.be.greaterThan(0);
        expect($canvas[0].height).to.be.greaterThan(0);
      });
    cy.wait('@zonesPmtiles', { timeout: 15000 })
      .its('response.statusCode')
      .should('be.oneOf', [200, 206]);
    cy.get('.map-pre-actions .fr-alert--error').should('not.exist');
  });
});
