/* global Cypress, cy, describe, expect, it */

const zonePublication = {
  id: '29959a00-0000-4000-8000-000000000000',
  revision: '42',
  pmtilesUrl: 'https://example.test/zones/42.pmtiles',
  pmtilesChecksum: 'a'.repeat(64),
};

const departments = Array.from({ length: 26 }, (_value, index) => ({
  code: String(index + 1).padStart(2, '0'),
  nom: `Département test ${String(index + 1).padStart(2, '0')}`,
  niveauGraviteMax: [
    null,
    'vigilance',
    'alerte',
    'alerte_renforcee',
    'crise',
  ][index % 5],
}));

const areaHistory = [
  {
    date: '2026-08-01',
    AEP: {
      vigilance: 10,
      alerte: 20,
      alerte_renforcee: 30,
      crise: 40,
    },
    ESU: {
      vigilance: 15,
      alerte: 25,
      alerte_renforcee: 30,
      crise: 30,
    },
    ESO: {
      vigilance: 20,
      alerte: 20,
      alerte_renforcee: 20,
      crise: 40,
    },
  },
];

const departmentHistory = [
  {
    date: '2026-08-01',
    departements: departments.map((department, index) => ({
      code: department.code,
      niveauGravite: [
        'vigilance',
        'alerte',
        'alerte_renforcee',
        'crise',
      ][index % 4],
      niveauGraviteAep: 'vigilance',
      niveauGraviteSup: 'alerte',
      niveauGraviteSou: 'alerte_renforcee',
    })),
  },
];

const communeHistory = {
  commune: { code: '75107', nom: 'Paris 7e arrondissement' },
  restrictions: Array.from({ length: 26 }, (_value, index) => ({
    date: `2026-07-${String(index + 1).padStart(2, '0')}`,
    AEP: index % 2 === 0 ? 'vigilance' : null,
    SUP: index % 3 === 0 ? 'alerte' : null,
    SOU: index % 5 === 0 ? 'crise' : null,
  })),
};

const publicStatistics = {
  subscriptions: 1234,
  statsByDay: [
    {
      date: '2026-08-01',
      visits: 100,
      restrictionsSearch: 50,
      arreteDownloads: 10,
    },
    {
      date: '2026-08-02',
      visits: 120,
      restrictionsSearch: 60,
      arreteDownloads: 12,
    },
  ],
  profileRepartition: {
    particulier: 60,
    exploitation: 20,
    entreprise: 15,
    collectivite: 5,
  },
  departementRepartition: Object.fromEntries(
    departments.map((department, index) => [department.code, index + 1]),
  ),
  regionRepartition: {
    '11': 25,
    '84': 75,
  },
};

const emptyMapStyle = {
  version: 8,
  name: 'Fond de carte simulé',
  sources: {},
  layers: [],
};

function stubReferenceData() {
  cy.intercept('GET', '**/data', {
    statusCode: 200,
    body: {
      bassinsVersants: [],
      regions: [],
      departements: [],
    },
  });
}

function stubRestrictionMap() {
  cy.intercept('GET', '**/zones/publication', {
    statusCode: 200,
    body: zonePublication,
  });
  cy.intercept(
    'GET',
    'https://openmaptiles.data.gouv.fr/styles/osm-bright/style.json',
    { statusCode: 200, body: emptyMapStyle },
  );
  cy.intercept(
    'GET',
    'https://openmaptiles.data.gouv.fr/data/decoupage-administratif.json',
    {
      statusCode: 200,
      body: { tilejson: '3.0.0', tiles: [] },
    },
  );
  cy.intercept('GET', 'https://example.test/zones/42.pmtiles*', {
    statusCode: 503,
    body: 'Archive cartographique indisponible pendant le test',
  });
}

function stubPublicDataApis() {
  stubReferenceData();
  stubRestrictionMap();
  cy.intercept('HEAD', '**/*.pmtiles*', {
    statusCode: 503,
    body: '',
  });
  cy.intercept('GET', '**/departements?*', {
    statusCode: 200,
    body: departments,
  });
  cy.intercept('GET', '**/arretes_restrictions?*', {
    statusCode: 200,
    body: [
      {
        id: 'arrete-test',
        numero: 'ARR-TEST-001',
        departement: { code: '01', nom: 'Ain' },
        niveauGraviteMax: 'alerte',
        types: ['AEP'],
        dateDebut: '2026-08-01',
        dateFin: null,
        fichier: null,
        arretesCadre: [],
      },
    ],
  });
  cy.intercept('GET', '**/data/area?*', {
    statusCode: 200,
    body: areaHistory,
  });
  cy.intercept('GET', '**/data/departement?*', {
    statusCode: 200,
    body: departmentHistory,
  });
  cy.intercept('GET', '**/data/duree', {
    statusCode: 200,
    body: [],
  });
  cy.intercept('GET', '**/data/commune/75107*', {
    statusCode: 200,
    body: communeHistory,
  });
  cy.intercept('GET', '**/statistics', {
    statusCode: 200,
    body: publicStatistics,
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

function assertVisibleControlsStayInViewport() {
  cy.get('main')
    .find('a[href], button, input, select, textarea, [role="tab"], [tabindex="0"]')
    .filter(':visible')
    .each(($control) => {
      const control = $control[0];
      if (control.closest('.accessible-data-table__scroll')) {
        return;
      }

      const rectangle = control.getBoundingClientRect();
      const viewportWidth = control.ownerDocument.documentElement.clientWidth;

      expect(rectangle.left, control.outerHTML).to.be.at.least(-0.5);
      expect(rectangle.right, control.outerHTML).to.be.at.most(
        viewportWidth + 0.5,
      );
    });
}

function assertAccessibleTablesAt320(expectedTableCount) {
  if (expectedTableCount === 0) {
    cy.get('.accessible-data-table').should('not.exist');
    return;
  }

  cy.get('.accessible-data-table')
    .should('have.length', expectedTableCount)
    .each(($component) => {
      cy.wrap($component).within(() => {
        cy.get('.accessible-data-table__scroll').should(($scrollRegion) => {
          expect(
            getComputedStyle($scrollRegion[0]).overflowX,
            'overflow horizontal du wrapper',
          ).to.equal('auto');
          expect($scrollRegion[0].scrollWidth).to.be.greaterThan(
            $scrollRegion[0].clientWidth,
          );
          expect($scrollRegion).to.have.attr('role', 'region');
          expect($scrollRegion).to.have.attr('tabindex', '0');
        });
        cy.get('table[id]').then(($table) => {
          const tableId = $table.attr('id');

          cy.get(`label[for="${tableId}-results-per-page"]`).should(
            'be.visible',
          );
          cy.get(`#${tableId}-results-per-page`)
            .should('be.visible')
            .and('have.attr', 'aria-controls', tableId);
          cy.get(`button[aria-controls="${tableId}"]`)
            .should('have.length', 4)
            .each(($button) => {
              const rectangle = $button[0].getBoundingClientRect();
              const viewportWidth =
                $button[0].ownerDocument.documentElement.clientWidth;

              expect(rectangle.left).to.be.at.least(-0.5);
              expect(rectangle.right).to.be.at.most(viewportWidth + 0.5);
            });
        });
      });
    });

  cy.get(
    [
      '.accessible-data-table table[id]',
      '.accessible-data-table select[id]',
    ].join(','),
  ).then(($elements) => {
    const ids = [...$elements].map((element) => element.id);

    expect(new Set(ids).size, 'identifiants des instances de tableau').to.equal(
      ids.length,
    );
  });
}

describe('Contrôles MapLibre accessibles dans le DOM rendu', () => {
  it('nomme la carte et ses contrôles en français et traite Entrée/Espace', () => {
    stubRestrictionMap();
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
      .then(($canvas) => {
        const canvas = $canvas[0];

        for (const key of ['Enter', ' ']) {
          let defaultPrevented = false;
          const observeEvent = (event) => {
            defaultPrevented = event.defaultPrevented;
          };
          canvas.addEventListener('keydown', observeEvent, { once: true });
          const dispatched = canvas.dispatchEvent(
            new KeyboardEvent('keydown', {
              key,
              bubbles: true,
              cancelable: true,
            }),
          );

          expect(defaultPrevented, `touche ${JSON.stringify(key)}`).to.equal(
            true,
          );
          expect(dispatched, `annulation ${JSON.stringify(key)}`).to.equal(
            false,
          );
        }
      });

    const controls = [
      ['.maplibregl-ctrl-zoom-in', 'Zoomer sur la carte'],
      ['.maplibregl-ctrl-zoom-out', 'Dézoomer sur la carte'],
      [
        '.maplibregl-ctrl-compass',
        'Réorienter la carte vers le nord',
      ],
      ['.maplibregl-ctrl-geolocate', 'Afficher ma position'],
    ];

    for (const [selector, accessibleName] of controls) {
      cy.get(selector)
        .should('be.visible')
        .and('have.attr', 'title', accessibleName)
        .and('have.attr', 'aria-label', accessibleName);
    }
  });

  it('ouvre et utilise le popup de restrictions au clavier sur une couche rendue', () => {
    stubRestrictionMap();
    cy.intercept('GET', '**/departements?*', {
      statusCode: 200,
      body: [],
    });
    cy.intercept('GET', '**/reverse?*', {
      statusCode: 200,
      body: {
        features: [
          {
            geometry: { coordinates: [2.308, 48.85] },
            properties: {
              citycode: '75107',
              context: '75, Paris, Île-de-France',
              label: '20 Avenue de Ségur 75007 Paris',
            },
          },
        ],
      },
    }).as('reverseGeocoding');
    cy.intercept('GET', '**/communes?*', {
      statusCode: 200,
      body: [
        {
          code: '75107',
          codeDepartement: '75',
          nom: 'Paris 7e arrondissement',
        },
      ],
    }).as('communeGeocoding');
    cy.intercept('GET', '**/zones?*', {
      statusCode: 200,
      body: [
        {
          id: 'zone-keyboard-test',
          type: 'AEP',
          profil: 'particulier',
          nom: 'Zone clavier test',
          departement: '75',
          niveauGravite: 'alerte',
          arreteMunicipalCheminFichier: '',
          usages: [],
          usagesHash: 'zone-keyboard-test',
        },
      ],
    }).as('restrictions');
    cy.visit('/carte');

    cy.window().should((window) => {
      expect(window.__vigieauMapForTests, 'instance MapLibre du composant')
        .not.to.equal(undefined);
      expect(
        window.__vigieauMapForTests.map.isStyleLoaded(),
        'style MapLibre chargé',
      ).to.equal(true);
    });
    cy.window().then((window) => {
      const mapControls = window.__vigieauMapForTests;
      const map = mapControls?.map;
      expect(map, 'instance MapLibre du composant').not.to.equal(undefined);
      const center = map.getCenter();
      map.addSource('zones-keyboard-test', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {
                id: 'zone-keyboard-test',
                type: 'AEP',
                niveauGravite: 'alerte',
                nom: 'Zone clavier test',
              },
              geometry: {
                type: 'Polygon',
                coordinates: [[
                  [center.lng - 5, center.lat - 5],
                  [center.lng + 5, center.lat - 5],
                  [center.lng + 5, center.lat + 5],
                  [center.lng - 5, center.lat + 5],
                  [center.lng - 5, center.lat - 5],
                ]],
              },
            },
          ],
        },
      });
      map.addLayer({
        id: 'zones-data',
        type: 'fill',
        source: 'zones-keyboard-test',
        paint: { 'fill-color': '#feb24c' },
      });
      mapControls.enableRestrictionsButton();
      return new Cypress.Promise((resolve) => {
        map.once('idle', resolve);
        map.triggerRepaint();
      });
    });

    cy.get('.maplibregl-canvas')
      .focus()
      .trigger('keydown', { key: 'Enter' });
    cy.wait(['@reverseGeocoding', '@communeGeocoding']);
    cy.get('.maplibregl-popup[role="dialog"]')
      .should('have.attr', 'aria-label', 'Informations sur le point sélectionné')
      .and('contain.text', 'Zone clavier test');
    cy.contains(
      '.maplibregl-popup',
      'Adresse proche : 20 Avenue de Ségur 75007 Paris',
    ).should('be.visible');
    cy.get('.maplibregl-popup-close-button')
      .should('have.attr', 'aria-label', 'Fermer les informations du point sélectionné')
      .click();
    cy.get('.maplibregl-canvas').should('be.focused');

    cy.get('.maplibregl-canvas')
      .trigger('keydown', { key: ' ' });
    cy.contains('.maplibregl-popup button', 'Je consulte les restrictions')
      .should('be.focused');
    cy.press(Cypress.Keyboard.Keys.TAB);
    cy.get('.maplibregl-popup-close-button').should('be.focused');
    cy.contains('.maplibregl-popup button', 'Je consulte les restrictions')
      .focus()
      .should('be.focused')
      .click();
    cy.wait('@restrictions');
    cy.location('pathname').should('equal', '/situation');
    cy.location('search')
      .should('contain', 'profil=particulier')
      .and('contain', 'typeEau=AEP');
  });
});

describe('Plusieurs tableaux paginés sur la même page', () => {
  function visitHistory(viewportWidth = 1400) {
    cy.viewport(viewportWidth, 800);
    stubReferenceData();
    stubRestrictionMap();
    cy.intercept('GET', '**/departements?*', {
      statusCode: 200,
      body: departments,
    }).as('departments');
    cy.intercept('GET', '**/arretes_restrictions?*', {
      statusCode: 200,
      body: [
        {
          id: 'arrete-test',
          numero: 'ARR-TEST-001',
          departement: { code: '01', nom: 'Ain' },
          niveauGraviteMax: 'alerte',
          types: ['AEP'],
          dateDebut: '2026-08-01',
          dateFin: null,
          fichier: null,
          arretesCadre: [],
        },
      ],
    }).as('restrictionOrders');

    cy.visit('/donnees/carte-historique');
    cy.wait(['@departments', '@restrictionOrders']);
  }

  it('génère des relations et identifiants distincts par instance', () => {
    visitHistory();

    cy.get(
      '#restriction-orders-table, #departments-table',
    ).should('have.length', 2);
    cy.get(
      '#restriction-orders-table-results-per-page, #departments-table-results-per-page',
    ).should('have.length', 2);

    cy.get('.accessible-data-table').each(($component) => {
      cy.wrap($component).within(() => {
        cy.get('table[id]').then(($table) => {
          const tableId = $table.attr('id');

          cy.get(`label[for="${tableId}-results-per-page"]`)
            .should('be.visible')
            .and('contain.text', 'Résultats par page');
          cy.get(`#${tableId}-results-per-page`)
            .should('have.attr', 'aria-controls', tableId);
        });
      });
    });

    cy.get(
      [
        '.accessible-data-table table[id]',
        '.accessible-data-table select[id]',
      ].join(','),
    ).then(($elements) => {
      const ids = [...$elements].map((element) => element.id);

      expect(new Set(ids).size, 'identifiants table et pagination').to.equal(
        ids.length,
      );
    });
    cy.get('.accessible-data-table nav[aria-label]')
      .then(($navigation) => {
        const names = [...$navigation].map((element) =>
          element.getAttribute('aria-label'),
        );

        expect(new Set(names).size, 'noms des deux paginations').to.equal(
          names.length,
        );
      });
  });

  it('limite le défilement horizontal aux deux wrappers à 320 px', () => {
    visitHistory(320);

    assertNoGlobalHorizontalOverflow();
    cy.get('.accessible-data-table__scroll')
      .should('have.length', 2)
      .each(($scrollRegion) => {
        expect($scrollRegion[0].scrollWidth).to.be.greaterThan(
          $scrollRegion[0].clientWidth,
        );
      });
    cy.get(
      [
        '.accessible-data-table__size',
        '.accessible-data-table nav',
        '.carte-table__download',
      ].join(','),
    ).each(($element) => {
      const rectangle = $element[0].getBoundingClientRect();
      const viewportWidth =
        $element[0].ownerDocument.documentElement.clientWidth;

      expect(rectangle.left).to.be.at.least(0);
      expect(rectangle.right).to.be.at.most(viewportWidth);
    });
  });
});

describe('Balayage Chrome des routes publiques de données à 320 px', () => {
  const publicRoutes = [
    {
      path: '/donnees',
      readySelector: 'h1',
      expectedTitle: 'Données sécheresse',
      tableCount: 0,
    },
    {
      path: '/donnees/carte-historique',
      readySelector: '#restriction-orders-table',
      expectedTitle: 'Carte et historique des restrictions',
      tableCount: 2,
    },
    {
      path: '/donnees/surface',
      readySelector: '#area-restrictions-history-table',
      expectedTitle:
        'Évolution journalière du pourcentage de la surface concernée',
      tableCount: 1,
    },
    {
      path: '/donnees/departement',
      readySelector: '#department-restrictions-history-table',
      expectedTitle:
        'Évolution journalière du nombre de départements soumis à restriction',
      tableCount: 1,
    },
    {
      path: '/donnees/carte-commune',
      readySelector: '#commune-drought-intensity-table',
      expectedTitle: 'Intensité des sécheresses passées',
      tableCount: 1,
    },
    {
      path: '/donnees/commune/75107',
      readySelector: '#commune-restrictions-history-table',
      expectedTitle: 'Commune - 75107',
      tableCount: 1,
    },
    {
      path: '/stats',
      readySelector: '#department-search-statistics-table',
      expectedTitle: 'Statistiques depuis le 10 Juillet 2023',
      tableCount: 3,
      openDataTab: true,
    },
  ];

  for (const route of publicRoutes) {
    it(`${route.path} reste utilisable sans débordement global`, () => {
      cy.viewport(320, 800);
      stubPublicDataApis();
      cy.visit(route.path);
      cy.contains('h1', route.expectedTitle).should('be.visible');
      cy.get(route.readySelector, { timeout: 15000 }).should('exist');

      if (route.openDataTab) {
        cy.get('#search-statistics-tab-data').click();
        cy.get('#search-statistics-panel-data').should('be.visible');
      }

      cy.document().then((document) => {
        const ids = [...document.querySelectorAll('[id]')]
          .map(element => element.id)
          .filter(Boolean);
        const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);

        expect([...new Set(duplicates)], 'IDs dupliqués').to.deep.equal([]);
      });

      if (route.path === '/stats') {
        cy.get('figure').should('have.length.at.least', 2);
        cy.get('#daily-statistics-table').should('exist');
        cy.get('#profile-statistics-table').should('exist');
      }
      if (route.path === '/donnees/commune/75107') {
        cy.get('[id^="commune-chart-"]').should('have.length', 4);
      }

      assertNoGlobalHorizontalOverflow();
      assertVisibleControlsStayInViewport();
      assertAccessibleTablesAt320(route.tableCount);
    });
  }
});
