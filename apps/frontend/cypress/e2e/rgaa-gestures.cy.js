/* global cy, describe, it */

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

const restrictionUsage = (id, thematique, nom) => ({
  id,
  thematique,
  nom,
  description: `Description ${nom}`,
  erreur: '',
  concerneParticulier: true,
  concerneEntreprise: true,
  concerneCollectivite: true,
  concerneExploitation: true,
});

describe('Filtres et structure des éco-gestes', () => {
  it('utilise des boutons pressés et une liste cohérente sans faux onglets', () => {
    cy.intercept('GET', '**/zones/publication', {
      statusCode: 503,
      body: { message: 'Publication indisponible pendant le test' },
    });
    cy.intercept('HEAD', '**/*.pmtiles*', { statusCode: 503 });
    cy.visit('/');

    cy.get('.gestes').within(() => {
      cy.get('[role="tablist"], [role="tabpanel"]').should('not.exist');
      cy.get('[role="group"][aria-label="Filtrer les éco-gestes"]')
        .should('be.visible');
      cy.get('#home-gestures-filter-0')
        .should('have.attr', 'aria-controls', 'home-gestures-results')
        .and('have.attr', 'aria-pressed', 'true');
      cy.get('#home-gestures-filter-1')
        .should('have.attr', 'aria-pressed', 'false')
        .focus()
        .click()
        .should('be.focused')
        .and('have.attr', 'aria-pressed', 'true');
      cy.get('#home-gestures-filter-0')
        .should('have.attr', 'aria-pressed', 'false');

      cy.get('#home-gestures-results')
        .should(
          'have.attr',
          'aria-labelledby',
          'home-gestures-filter-1',
        )
        .find('ul.gestures-list[role="list"] > li')
        .should('have.length', 6)
        .each(($item) => {
          cy.wrap($item).find('p').should('have.length', 1);
          cy.wrap($item).invoke('text').should('match', /\S/);
          cy.wrap($item).find('[aria-hidden="true"] svg').should('exist');
        });
    });
  });

  it('filtre les restrictions par boutons sans tablist orpheline', () => {
    cy.viewport(1400, 800);
    cy.intercept('GET', '**/search/?q=*', {
      statusCode: 200,
      body: {
        type: 'FeatureCollection',
        features: [addressFeature],
      },
    });
    cy.intercept('GET', '**/zones/publication', {
      statusCode: 200,
      body: {
        id: '29959a00-0000-4000-8000-000000000000',
        revision: '42',
        pmtilesUrl: 'https://example.test/zones/42.pmtiles',
        pmtilesChecksum: 'a'.repeat(64),
      },
    });
    cy.intercept('GET', '**/zones?*', {
      statusCode: 200,
      body: [
        {
          id: 'zone-test',
          type: 'AEP',
          profil: 'particulier',
          nom: 'Zone de test',
          departement: '75',
          niveauGravite: 'alerte',
          arrete: {
            idArrete: 'arrete-test',
            dateDebutValidite: '2026-08-01',
            dateFinValidite: '2026-08-31',
            cheminFichier: '',
            cheminFichierArreteCadre: '',
          },
          arreteMunicipalCheminFichier: '',
          usages: [
            restrictionUsage(1, 'Arroser', 'Arrosage test'),
            restrictionUsage(2, 'Nettoyer', 'Nettoyage test'),
          ],
          usagesHash: 'zone-test',
        },
      ],
    });

    cy.visit(
      '/situation?adresse=20+Avenue+de+Segur+75007+Paris&profil=particulier&typeEau=AEP',
    );
    cy.contains('h2', 'Détails des restrictions').should('be.visible');
    cy.get('.situation-status').within(() => {
      cy.get('[role="tablist"], [role="tabpanel"]').should('not.exist');
      cy.get(
        '[role="group"][aria-label="Filtrer les restrictions par type d’usage"]',
      ).should('be.visible');
      cy.get('#restriction-theme-filter-0')
        .should('have.attr', 'aria-pressed', 'true')
        .and('have.attr', 'aria-controls', 'restriction-theme-results');
      cy.get('#restriction-theme-results')
        .should(
          'have.attr',
          'aria-labelledby',
          'restriction-theme-filter-0',
        )
        .and('contain.text', 'Arrosage test')
        .and('not.contain.text', 'Nettoyage test');

      cy.get('#restriction-theme-filter-1').click()
        .should('have.attr', 'aria-pressed', 'true');
      cy.get('#restriction-theme-results')
        .should(
          'have.attr',
          'aria-labelledby',
          'restriction-theme-filter-1',
        )
        .and('contain.text', 'Nettoyage test')
        .and('not.contain.text', 'Arrosage test');
    });
  });
});
