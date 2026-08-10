/* global beforeEach, cy, describe, expect, it */

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

const validZonePublication = {
  id: '29959a00-0000-4000-8000-000000000000',
  revision: '42',
  pmtilesUrl: 'https://example.test/zones/42.pmtiles',
  pmtilesChecksum: 'a'.repeat(64),
};

const restrictionUsage = {
  id: 101,
  thematique: 'Arroser',
  nom: 'Arrosage des jardins',
  description: 'Description accessible de la restriction',
  erreur: '',
  concerneParticulier: true,
  concerneEntreprise: true,
  concerneCollectivite: true,
  concerneExploitation: true,
};

const restrictionZone = {
  id: 'zone-document',
  type: 'AEP',
  profil: 'particulier',
  nom: 'Zone avec arrêté',
  departement: '75',
  niveauGravite: 'crise',
  arrete: {
    idArrete: 'arrete-document',
    dateDebutValidite: '2026-08-01',
    dateFinValidite: '2026-08-31',
    cheminFichier: 'https://example.test/arrete.pdf',
    cheminFichierArreteCadre: '',
  },
  arreteMunicipalCheminFichier: '',
  usages: [restrictionUsage],
  usagesHash: 'zone-document',
};

function stubSharedApis() {
  cy.intercept('GET', '**/data', {
    statusCode: 200,
    body: {
      bassinsVersants: [],
      regions: [],
      departements: [],
    },
  });
  cy.intercept('GET', '**/zones/publication', {
    statusCode: 503,
    body: { message: 'Publication indisponible pendant le test' },
  });
  cy.intercept('HEAD', '**/*.pmtiles*', {
    statusCode: 503,
    body: '',
  });
}

function pageContainer() {
  return cy.get('main h1').closest('.fr-container');
}

function assertInstitutionalStructure(expectedTableCount) {
  pageContainer()
    .should('have.length', 1)
    .then(($container) => {
      const container = $container[0];
      const paragraphs = [...container.querySelectorAll('p')];
      const lists = [...container.querySelectorAll('ul, ol')];
      const tables = [...container.querySelectorAll('table')];

      expect(paragraphs.length, 'paragraphs').to.be.greaterThan(0);
      for (const paragraph of paragraphs) {
        expect(paragraph.textContent.trim(), 'non-empty paragraph').not.to.equal('');
        expect(
          paragraph.querySelectorAll('div, ol, table, ul'),
          'no block content inside paragraphs',
        ).to.have.length(0);
      }

      expect(lists.length, 'lists').to.be.greaterThan(0);
      for (const list of lists) {
        const directElements = [...list.children];

        expect(directElements.length, 'non-empty list').to.be.greaterThan(0);
        expect(
          directElements.every(element => element.tagName === 'LI'),
          'only list items are direct children',
        ).to.equal(true);
      }

      expect(tables, 'table count').to.have.length(expectedTableCount);
      for (const table of tables) {
        expect(table.closest('p'), 'table outside paragraphs').to.equal(null);
        expect(table.querySelectorAll(':scope > caption')).to.have.length(1);
        expect(table.querySelectorAll(':scope > thead')).to.have.length(1);
        expect(table.querySelectorAll(':scope > tbody')).to.have.length(1);

        for (const row of table.querySelectorAll('tr')) {
          const cells = [...row.children];

          expect(cells.length, 'non-empty table row').to.be.greaterThan(0);
          expect(
            cells.every(cell => cell.matches('th, td')),
            'only cells are direct row children',
          ).to.equal(true);
        }
      }
    });
}

function documentNotice() {
  return cy.contains(
    'p',
    'Les informations affichées sur cette page facilitent la consultation',
  );
}

describe('Documents et pages institutionnelles accessibles', () => {
  beforeEach(() => {
    stubSharedApis();
  });

  it('conserve la structure et les libellés corrigés de la déclaration d’accessibilité', () => {
    cy.visit('/accessibilite');
    cy.get('main h1').should('have.text', 'Déclaration d’accessibilité');
    assertInstitutionalStructure(0);

    pageContainer().within(() => {
      cy.get('#amelioration-contact')
        .should('be.visible')
        .and('contain.text', 'Amélioration et contact');
      cy.contains('responsable de VigiEau').should('be.visible');
      cy.contains('Parmi les points bloquants').should('be.visible');
      cy.contains('Cette déclaration d’accessibilité a été créée').should(
        'be.visible',
      );
      cy.contains('constats ci-dessous sont ceux de l’audit de janvier 2025')
        .should('be.visible');
      cy.get('a[href*="#plan-2024"]').should('not.exist');
      cy.get(
        'a[href="https://beta.gouv.fr/accessibilite/schema-pluriannuel#plan-2026"]',
      ).should('be.visible');
      cy.get('a[href^="mailto:"]').should('be.visible');
      cy.get('a[href^="tel:"]').should('be.visible');
      cy.root()
        .should('not.contain.text', 'Parmis')
        .and('not.contain.text', 'responsable de Potentiel');
    });
  });

  it('conserve des paragraphes, listes et tableaux valides sur les données personnelles', () => {
    cy.visit('/donnees-personnelles');
    cy.get('main h1').should('have.text', 'Politique de confidentialité');
    assertInstitutionalStructure(2);

    pageContainer().within(() => {
      cy.get('table caption')
        .should('have.length', 2)
        .then(($captions) => {
          expect($captions.eq(0)).to.contain.text(
            'Durée de conservation des données personnelles',
          );
          expect($captions.eq(1)).to.contain.text('Sous-traitants de données');
        });
      cy.contains('article 6-1 e) du RGPD').should('be.visible');
      cy.contains('se désinscrive de la lettre d’information').should(
        'be.visible',
      );
      cy.contains('l’accès physique aux données').should('be.visible');
      cy.root()
        .should('not.contain.text', 'RPGD')
        .and('not.contain.text', 'identité.}')
        .and('not.contain.text', 'l’accès physiques');
    });
  });

  it('conserve la structure et les libellés corrigés des mentions légales', () => {
    cy.visit('/mentions-legales');
    cy.get('main h1').should('have.text', 'Mentions légales');
    assertInstitutionalStructure(0);

    pageContainer().within(() => {
      cy.contains('directeur général de').should('be.visible');
      cy.contains('La newsletter est gérée par la société Brevo').should(
        'be.visible',
      );
      cy.root()
        .should('not.contain.text', 'par intérim')
        .and('not.contain.text', 'La newsletter est géré par');
    });
  });

  it('propose une alternative quand la situation contient un arrêté', () => {
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
      body: [restrictionZone],
    }).as('zoneSearch');

    cy.visit(
      '/situation?adresse=20+Avenue+de+Segur+75007+Paris&profil=particulier&typeEau=AEP',
    );
    cy.wait('@zoneSearch');
    cy.get('.situation-status').should('be.visible');
    documentNotice()
      .should('be.visible')
      .and('contain.text', 'fournis par les services locaux de l’État')
      .and('contain.text', 'orienté vers une alternative')
      .find('a[href="/accessibilite#amelioration-contact"]')
      .should(($link) => {
        expect($link.text().trim()).to.equal('contactez l’équipe VigiEau');
      });
  });

  it('propose l’alternative sur les données et focalise le contact après activation', () => {
    cy.intercept('GET', '**/departements?*', {
      statusCode: 200,
      body: [],
    });
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

    cy.visit('/donnees/carte-historique');
    cy.wait('@restrictionOrders');
    cy.get('#restriction-orders-table').should('be.visible');
    documentNotice()
      .should('be.visible')
      .and('contain.text', 'orienté vers une alternative')
      .find('a[href="/accessibilite#amelioration-contact"]')
      .click();

    cy.location('pathname').should('equal', '/accessibilite');
    cy.location('hash').should('equal', '#amelioration-contact');
    cy.get('#amelioration-contact')
      .should('be.visible')
      .and('be.focused')
      .then(($heading) => {
        const rectangle = $heading[0].getBoundingClientRect();

        expect(rectangle.bottom, 'fragment below viewport top').to.be.greaterThan(0);
        expect(rectangle.top, 'fragment above viewport bottom').to.be.lessThan(
          $heading[0].ownerDocument.documentElement.clientHeight,
        );
      });
  });
});
