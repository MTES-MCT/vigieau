/* global cy, describe, expect, it */

const addressFeature = {
  type: 'Feature',
  geometry: { coordinates: [2.308, 48.85] },
  properties: {
    id: '75107_8240_00020',
    type: 'housenumber',
    label: '20 Avenue de Ségur 75007 Paris',
    postcode: '75007',
    citycode: '75107',
    context: '75, Paris, Île-de-France',
  },
};

const situationZone = {
  id: 'zone-test',
  type: 'AEP',
  profil: 'particulier',
  nom: 'Zone de test',
  departement: '75',
  niveauGravite: 'vigilance',
  arreteMunicipalCheminFichier: '',
  usages: [],
  usagesHash: 'zone-test',
};

const validZonePublication = {
  id: '29959a00-0000-4000-8000-000000000000',
  revision: '42',
  pmtilesUrl: 'https://example.test/zones/42.pmtiles',
  pmtilesChecksum: 'a'.repeat(64),
};

function stubUnavailablePublication() {
  cy.intercept('GET', '**/zones/publication', {
    statusCode: 503,
    body: { message: 'Publication indisponible pendant le test' },
  });
  cy.intercept('HEAD', '**/*.pmtiles*', {
    statusCode: 503,
    body: '',
  });
}

function assertNoGlobalHorizontalOverflow() {
  cy.document().should((document) => {
    expect(
      document.documentElement.scrollWidth,
      'largeur globale du document',
    ).to.be.at.most(document.documentElement.clientWidth);
    expect(
      document.body.scrollWidth,
      'largeur globale du corps de page',
    ).to.be.at.most(document.documentElement.clientWidth);
  });
}

describe('Onglets accessibles de la carte et alternative de données', () => {
  it('relie les onglets aux panneaux sans arrêt de tabulation superflu', () => {
    stubUnavailablePublication();
    cy.intercept('GET', '**/departements?*', {
      statusCode: 200,
      body: [],
    });
    cy.visit('/carte');

    cy.contains('h1', 'Carte des restrictions')
      .next('p')
      .should('contain.text', 'Arrêtés publiés avant le');
    cy.get('[role="tablist"]')
      .should('have.attr', 'aria-label', 'Présentation des restrictions');

    for (const name of ['map', 'data']) {
      cy.get(`#restrictions-tab-${name}`).should(($tab) => {
        const panelId = $tab.attr('aria-controls');
        const panel = $tab[0].ownerDocument.getElementById(panelId);

        expect(panel).not.to.equal(null);
        expect(panel.getAttribute('aria-labelledby')).to.equal($tab.attr('id'));
        expect(panel.getAttribute('tabindex')).to.equal('-1');
      });
    }
  });

  it('déplace sélection et focus avec les flèches, Début et Fin', () => {
    stubUnavailablePublication();
    cy.intercept('GET', '**/departements?*', {
      statusCode: 200,
      body: [],
    });
    cy.visit('/carte');

    cy.get('#restrictions-tab-map')
      .focus()
      .trigger('keydown', { key: 'ArrowRight' });
    cy.get('#restrictions-tab-data')
      .should('be.focused')
      .and('have.attr', 'aria-selected', 'true')
      .and('have.attr', 'tabindex', '0')
      .trigger('keydown', { key: 'ArrowLeft' });
    cy.get('#restrictions-tab-map')
      .should('be.focused')
      .and('have.attr', 'aria-selected', 'true')
      .trigger('keydown', { key: 'ArrowRight' });
    cy.get('#restrictions-tab-data')
      .trigger('keydown', { key: 'Home' });
    cy.get('#restrictions-tab-map')
      .should('be.focused')
      .and('have.attr', 'aria-selected', 'true')
      .trigger('keydown', { key: 'End' });
    cy.get('#restrictions-tab-data').should('be.focused');
    cy.get('#restrictions-tab-map')
      .should('have.attr', 'aria-selected', 'false')
      .and('have.attr', 'tabindex', '-1');
  });

  it('propose une action visible qui ouvre le tableau et focalise son onglet', () => {
    stubUnavailablePublication();
    cy.intercept('GET', '**/departements?*', {
      statusCode: 200,
      body: [],
    });
    cy.visit('/carte');

    cy.get('#restrictions-map-instructions')
      .should('be.visible')
      .and('contain.text', 'Entrée ou Espace')
      .and('contain.text', 'alternative accessible');
    cy.contains('button', 'Consulter les données sous forme de tableau')
      .click();
    cy.get('#restrictions-tab-data')
      .should('be.focused')
      .and('have.attr', 'aria-selected', 'true');
    cy.get('#restrictions-panel-data')
      .should('be.visible')
      .and('have.attr', 'tabindex', '-1');
  });

  it('nomme en français la carte et ses contrôles dans le DOM généré', () => {
    cy.intercept('GET', '**/zones/publication', {
      statusCode: 200,
      body: validZonePublication,
    });
    cy.intercept(
      'GET',
      'https://openmaptiles.data.gouv.fr/styles/osm-bright/style.json',
      { statusCode: 200, body: { version: 8, sources: {}, layers: [] } },
    );
    cy.intercept('GET', 'https://example.test/zones/42.pmtiles*', {
      statusCode: 404,
      body: '',
    });
    cy.intercept('GET', '**/departements?*', {
      statusCode: 200,
      body: [],
    });
    cy.visit('/carte');

    cy.get('.maplibregl-canvas', { timeout: 15000 })
      .should(
        'have.attr',
        'aria-label',
        'Carte interactive des restrictions d’usage de l’eau en France',
      )
      .and(
        'have.attr',
        'aria-describedby',
        'restrictions-map-instructions',
      )
      .focus()
      .should('be.focused');
    cy.get('.maplibregl-ctrl-zoom-in')
      .should('have.attr', 'aria-label', 'Zoomer sur la carte');
    cy.get('.maplibregl-ctrl-zoom-out')
      .should('have.attr', 'aria-label', 'Dézoomer sur la carte');
    cy.get('.maplibregl-ctrl-geolocate')
      .should('have.attr', 'aria-label', 'Afficher ma position');
  });
});

describe('Absence de débordement global à 320 px', () => {
  it('conserve l’accueil, les gestes et les liens dans le viewport', () => {
    cy.viewport(320, 800);
    stubUnavailablePublication();
    cy.visit('/');

    cy.get('#home-map-instructions')
      .should('be.visible')
      .and('contain.text', 'saisir directement votre adresse')
      .and('contain.text', 'Entrée ou Espace');
    cy.get('.gestes').should('be.visible');
    cy.get('.liens').should('be.visible');
    assertNoGlobalHorizontalOverflow();
  });

  it('conserve l’en-tête de situation dans le viewport', () => {
    cy.viewport(320, 800);
    cy.intercept('GET', '**/search/?q=*', {
      statusCode: 200,
      body: {
        type: 'FeatureCollection',
        features: [addressFeature],
      },
    });
    cy.intercept('GET', '**/zones/publication', {
      statusCode: 200,
      body: validZonePublication,
    });
    cy.intercept('GET', '**/zones?*', {
      statusCode: 200,
      body: [situationZone],
    });
    cy.visit(
      '/situation?adresse=20+Avenue+de+Segur+75007+Paris&profil=particulier&typeEau=AEP',
    );

    cy.get('.situation-status-header').should('be.visible');
    assertNoGlobalHorizontalOverflow();
  });

  it('conserve la carte communale et ses contrôles dans le viewport', () => {
    cy.viewport(320, 800);
    cy.intercept('GET', '**/data', {
      statusCode: 200,
      body: {
        bassinsVersants: [],
        regions: [],
        departements: [],
      },
    });
    cy.intercept('GET', '**/data/duree', {
      statusCode: 200,
      body: [],
    });
    cy.intercept(
      'GET',
      'https://openmaptiles.data.gouv.fr/styles/osm-bright/style.json',
      { statusCode: 200, body: { version: 8, sources: {}, layers: [] } },
    );
    cy.visit('/donnees/carte-commune');

    cy.contains('h1', 'Intensité des sécheresses passées')
      .should('be.visible');
    assertNoGlobalHorizontalOverflow();
  });
});
