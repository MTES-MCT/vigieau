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

const validZonePublication = {
  id: '29959a00-0000-4000-8000-000000000000',
  revision: '42',
  pmtilesUrl: 'https://example.test/zones/42.pmtiles',
  pmtilesChecksum: 'a'.repeat(64),
};

const zones = [
  {
    id: 'zone-amont',
    type: 'SUP',
    profil: 'particulier',
    nom: 'Bassin amont',
    departement: '75',
    niveauGravite: 'alerte',
    arreteMunicipalCheminFichier: '',
    usages: [],
    usagesHash: 'amont',
  },
  {
    id: 'zone-aval',
    type: 'SUP',
    profil: 'particulier',
    nom: 'Bassin aval',
    departement: '75',
    niveauGravite: 'vigilance',
    arreteMunicipalCheminFichier: '',
    usages: [],
    usagesHash: 'aval',
  },
];

const selectIds = [
  'situation-water-type',
  'situation-alert-zone',
  'situation-profile',
  'situation-alert-zone-modal',
];

function visitSituationWithTwoZones(viewportWidth) {
  cy.viewport(viewportWidth, 800);
  cy.intercept('GET', '**/search/?q=*', {
    statusCode: 200,
    body: {
      type: 'FeatureCollection',
      features: [addressFeature],
    },
  }).as('addressSearch');
  cy.intercept('GET', '**/zones/publication', {
    statusCode: 200,
    body: validZonePublication,
  }).as('zonePublication');
  cy.intercept('GET', '**/zones?*', {
    statusCode: 200,
    body: zones,
  }).as('zoneSearch');

  cy.visit(
    '/situation?adresse=20+Avenue+de+Segur+75007+Paris&profil=particulier&typeEau=SUP',
  );
  cy.location('pathname').should('equal', '/situation');
  cy.get('.situation-status').should('exist');
}

function assertAssociatedUniqueLabels() {
  cy.get('.situation-status fieldset.situation-status__selectors').should(
    'have.length',
    1,
  );
  cy.get('.situation-status__selectors legend')
    .should('have.length', 1)
    .and('contain.text', 'Adapter les restrictions');

  for (const id of selectIds) {
    cy.get(`#${id}`)
      .should('have.length', 1)
      .and(($select) => {
        expect($select).to.match('select');
        expect($select).not.to.have.attr('title');
        expect($select).not.to.have.attr('titile');
      });
    cy.get(`label[for="${id}"]`)
      .should('have.length', 1)
      .invoke('text')
      .should('match', /\S/);
  }

  cy.get('.situation-status select[title], .situation-status select[titile]')
    .should('not.exist');
}

function assertSelectorsFitViewport() {
  cy.get('.situation-status__selectors').then(($fieldset) => {
    expect($fieldset[0].scrollWidth).to.be.at.most(
      $fieldset[0].clientWidth,
    );
  });
  cy.get('.situation-status__selectors')
    .find('.fr-select-group, label, select')
    .each(($element) => {
      const rectangle = $element[0].getBoundingClientRect();

      expect(rectangle.left).to.be.at.least(0);
      expect(rectangle.right).to.be.at.most(
        $element[0].ownerDocument.documentElement.clientWidth,
      );
    });
}

function selectZoneFromModal() {
  cy.get('#situation-alert-zone-modal')
    .should('be.visible')
    .then(($select) => {
      const rectangle = $select[0].getBoundingClientRect();

      expect(rectangle.left).to.be.at.least(0);
      expect(rectangle.right).to.be.at.most(
        $select[0].ownerDocument.documentElement.clientWidth,
      );
    })
    .select('zone-aval');
  cy.get('.fr-modal--opened')
    .contains('button', 'Valider')
    .click();
  cy.get('#situation-alert-zone').should('have.value', 'zone-aval');
}

describe('Sélecteurs accessibles de la situation', () => {
  it('rend un seul groupe relié et synchronise la zone sur grand écran', () => {
    visitSituationWithTwoZones(1400);
    assertAssociatedUniqueLabels();
    cy.get('#situation-update-status').should('have.text', '');

    selectZoneFromModal();
    cy.get('#situation-update-status').should(
      'have.text',
      'Restrictions mises à jour pour la zone d’alerte « Bassin aval ».',
    );

    cy.get('#situation-profile').select('entreprise');
    cy.get('#situation-update-status').should(
      'have.text',
      'Restrictions mises à jour pour le profil professionnel.',
    );

    cy.get('#situation-water-type').select('AEP');
    cy.get('#situation-update-status').should(
      'have.text',
      'Restrictions mises à jour pour l’eau du robinet.',
    );

    assertSelectorsFitViewport();
  });

  it('ne duplique aucun identifiant et ne déborde pas à 320 px', () => {
    visitSituationWithTwoZones(320);
    assertAssociatedUniqueLabels();
    selectZoneFromModal();
    assertSelectorsFitViewport();
  });
});
