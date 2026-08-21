/* global cy, describe, expect, it */

const departments = Array.from({ length: 26 }, (_value, index) => ({
  code: String(index + 1).padStart(2, '0'),
  nom: `Département test ${String(index + 1).padStart(2, '0')}`,
  region: 'Région de test',
  niveauGraviteMax: [
    null,
    'vigilance',
    'alerte',
    'alerte_renforcee',
    'crise',
  ][index % 5],
}));

const paginationButtonNames = [
  'Aller à la première page du tableau des départements',
  'Aller à la page précédente du tableau des départements',
  'Aller à la page suivante du tableau des départements',
  'Aller à la dernière page du tableau des départements',
];

function visitDepartmentTable(viewportWidth = 1400) {
  cy.viewport(viewportWidth, 800);
  cy.intercept('GET', '**/departements?*', {
    statusCode: 200,
    body: departments,
  }).as('departments');
  cy.intercept('GET', '**/zones/publication', {
    statusCode: 503,
    body: { message: 'Publication indisponible pendant le test' },
  });
  cy.intercept('HEAD', '**/*.pmtiles*', {
    statusCode: 503,
  });

  cy.visit('/carte');
  cy.wait('@departments');
  cy.contains('[role="tab"]', 'Données').click();
  cy.get('#restrictions-panel-data').should('be.visible');
  cy.get('#departments-table tbody tr').should('have.length', 10);
  if (viewportWidth >= 1000) {
    cy.get('.carte-table .accessible-data-table__scroll').should(($element) => {
      expect($element.attr('tabindex')).to.equal(undefined);
      expect($element.attr('role')).to.equal(undefined);
    });
  }
}

function departmentTableStatus() {
  return cy
    .get('#departments-table')
    .parents('.accessible-data-table')
    .find('[role="status"]');
}

describe('Tableau public des départements accessible', () => {
  it('relie le filtre, sépare la pagination et annonce chaque mise à jour', () => {
    visitDepartmentTable();

    cy.get('.departement-card-list > li')
      .should('have.length', 5)
      .each(($item) => {
        cy.wrap($item).find('.fr-badge').should('have.length', 1);
        cy.wrap($item)
          .find('.departement-card__number')
          .invoke('text')
          .should('match', /\d+ départements?/);
      });

    cy.get('label[for="department-filter"]')
      .should('be.visible')
      .and('contain.text', 'Rechercher un département');
    cy.get('#department-filter')
      .should('have.attr', 'type', 'search')
      .and('have.attr', 'autocomplete', 'off');
    cy.contains('button[type="submit"]', 'Rechercher un département')
      .should('be.visible');

    cy.get('#departments-table caption')
      .should('be.visible')
      .and('contain.text', 'Niveau de gravité maximal observé');
    cy.get('#departments-table thead th[scope="col"]')
      .should('have.length', 3);
    cy.get('#departments-table tbody')
      .find('button, select, nav, [role="status"]')
      .should('not.exist');
    cy.get('nav[aria-label="Pagination du tableau des départements"]')
      .should('be.visible')
      .parents('table')
      .should('not.exist');

    for (const name of paginationButtonNames) {
      cy.get(`button[aria-label="${name}"]`).should('have.length', 1);
    }

    cy.get(
      'button[aria-label="Aller à la première page du tableau des départements"]',
    ).should('be.disabled');
    cy.get(
      'button[aria-label="Aller à la page précédente du tableau des départements"]',
    ).should('be.disabled');
    cy.get(
      'button[aria-label="Aller à la page suivante du tableau des départements"]',
    ).should('not.be.disabled').click();
    departmentTableStatus().should('contain.text', 'Page 2 sur 3');

    cy.get('#department-filter').type('Département test 26{enter}');
    departmentTableStatus()
      .should('have.length', 1)
      .should('contain.text', '1 département trouvé')
      .and('contain.text', 'Département test 26')
      .and('contain.text', 'Page 1 sur 1');
    cy.get('#departments-table tbody tr')
      .should('have.length', 1)
      .and('contain.text', 'Département test 26');

    cy.get('#department-filter').clear().type('Département absent{enter}');
    departmentTableStatus()
      .should('contain.text', '0 départements trouvés')
      .and('contain.text', 'Département absent')
      .and('contain.text', 'Aucun résultat à afficher');
    cy.get('#departments-table tbody tr').should('not.exist');

    cy.get('#department-filter').clear();
    cy.contains('button[type="submit"]', 'Rechercher un département').click();
    departmentTableStatus()
      .should('contain.text', '26 départements affichés')
      .and('contain.text', 'Page 1 sur 3');

    cy.get(
      'button[aria-label="Aller à la page suivante du tableau des départements"]',
    ).click();
    departmentTableStatus()
      .should('contain.text', 'Page 2 sur 3')
      .and('contain.text', 'Résultats 11 à 20 sur 26');
    cy.get('#departments-table tbody tr')
      .should('have.length', 10)
      .first()
      .should('contain.text', 'Département test 11');

    cy.get(
      'button[aria-label="Aller à la dernière page du tableau des départements"]',
    ).click();
    departmentTableStatus()
      .should('contain.text', 'Page 3 sur 3')
      .and('contain.text', 'Résultats 21 à 26 sur 26');
    cy.get(
      'button[aria-label="Aller à la page suivante du tableau des départements"]',
    ).should('be.disabled');
    cy.get(
      'button[aria-label="Aller à la dernière page du tableau des départements"]',
    ).should('be.disabled');

    cy.get('label[for="departments-table-results-per-page"]')
      .should('be.visible')
      .and('contain.text', 'Résultats par page')
      .and('contain.text', 'mise à jour automatique');
    cy.get('#departments-table-results-per-page')
      .should('have.attr', 'aria-controls', 'departments-table')
      .select('25');
    departmentTableStatus()
      .should('contain.text', 'Affichage de 25 résultats par page')
      .should('contain.text', 'Page 1 sur 2')
      .and('contain.text', 'Résultats 1 à 25 sur 26');
    cy.get('#departments-table tbody tr')
      .should('have.length', 25)
      .first()
      .should('contain.text', 'Département test 01');
  });

  it('préserve le tableau, la pagination et l’export en variante light', () => {
    cy.intercept('GET', '**/data', {
      statusCode: 200,
      body: {
        bassinsVersants: [],
        regions: [],
        departements: [],
      },
    });
    cy.intercept('GET', '**/departements?*', {
      statusCode: 200,
      body: departments,
    }).as('lightDepartments');
    cy.intercept('GET', '**/arretes_restrictions?*', {
      statusCode: 200,
      body: [
        {
          id: 'arrete-test',
          numero: 'ARR-2026-01',
          dateDebut: '2026-08-01',
          dateFin: null,
          dateSignature: '2026-08-01',
          statut: 'publie',
          departement: { code: '01', nom: 'Ain' },
          niveauGraviteMax: 'alerte',
          types: ['SUP'],
          fichier: { url: 'https://example.test/arrete.pdf' },
          arretesCadre: [],
        },
      ],
    }).as('restrictionOrders');
    cy.intercept('GET', '**/zones/publication', {
      statusCode: 503,
      body: { message: 'Publication indisponible pendant le test' },
    });
    cy.intercept('HEAD', '**/*.pmtiles*', {
      statusCode: 503,
    });

    cy.visit('/donnees/carte-historique');
    cy.wait('@lightDepartments');
    cy.wait('@restrictionOrders');
    cy.get('.carte-table__light').should('be.visible').within(() => {
      cy.get('.department-filter').should('not.exist');
      cy.get('#departments-table caption').should('be.visible');
      cy.get('#departments-table tbody tr').should('have.length', 10);
      cy.get('#departments-table-results-per-page').should('be.visible');
      cy.contains('button', 'Télécharger les données (CSV)').should(
        'be.visible',
      );
    });
    cy.get('.accessible-data-table table[id]').should(($tables) => {
      const ids = [...$tables].map(table => table.id);

      expect(ids.length).to.be.at.least(2);
      expect(new Set(ids).size).to.equal(ids.length);
    });
    cy.get('#restriction-orders-table')
      .find('a[href="https://example.test/arrete.pdf"]')
      .should('have.attr', 'target', '_blank')
      .and('contain.text', "Ouvrir l'arrêté");
    cy.get('.accessible-data-table select[id$="-results-per-page"]')
      .should(($selects) => {
        const ids = [...$selects].map(select => select.id);

        expect(ids.length).to.be.at.least(2);
        expect(new Set(ids).size).to.equal(ids.length);
      });
  });

  it('conserve tous les contrôles dans le viewport à 320 px', () => {
    visitDepartmentTable(320);

    cy.document().then((document) => {
      expect(document.documentElement.scrollWidth).to.be.at.most(
        document.documentElement.clientWidth,
      );
    });
    cy.get('.carte-table .accessible-data-table__scroll').should(($scrollRegion) => {
      expect($scrollRegion[0].scrollWidth).to.be.greaterThan(
        $scrollRegion[0].clientWidth,
      );
      expect($scrollRegion).to.have.attr('role', 'region');
      expect($scrollRegion).to.have.attr('tabindex', '0');
    });
    cy.get(
      [
        '.department-filter',
        '#departments-table-results-per-page',
        '.accessible-data-table__pagination nav',
        '.carte-table__download',
      ].join(','),
    ).each(($element) => {
      const rectangle = $element[0].getBoundingClientRect();
      const viewportWidth = $element[0].ownerDocument.documentElement.clientWidth;

      expect(rectangle.left).to.be.at.least(0);
      expect(rectangle.right).to.be.at.most(viewportWidth);
    });

    for (const name of paginationButtonNames) {
      cy.get(`button[aria-label="${name}"]`).should('be.visible');
    }
  });
});
