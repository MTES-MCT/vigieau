/* global cy */

export const addressFeature = {
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

const zonePublication = {
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

export function situationZone({
  id,
  departement = '75',
  niveauGravite,
  restrictions = false,
}) {
  return {
    id,
    type: 'AEP',
    profil: 'particulier',
    nom: `Zone ${id}`,
    departement,
    niveauGravite,
    arrete: {
      idArrete: `arrete-${id}`,
      dateDebutValidite: '2026-08-01',
      dateFinValidite: '2026-08-31',
      cheminFichier: '',
      cheminFichierArreteCadre: '',
    },
    arreteMunicipalCheminFichier: '',
    usages: restrictions ? [restrictionUsage] : [],
    usagesHash: id,
  };
}

export function stubSituationApis(zone) {
  cy.intercept('GET', '**/search/?q=*', {
    statusCode: 200,
    body: {
      type: 'FeatureCollection',
      features: [addressFeature],
    },
  }).as('addressSearch');
  cy.intercept('GET', '**/zones/publication', {
    statusCode: 200,
    body: zonePublication,
  }).as('zonePublication');
  cy.intercept('GET', '**/zones?*', {
    statusCode: 200,
    body: [zone],
  }).as('zoneSearch');
  cy.intercept(
    'GET',
    'https://openmaptiles.data.gouv.fr/styles/osm-bright/style.json',
    { statusCode: 200, body: { version: 8, sources: {}, layers: [] } },
  );
  cy.intercept('GET', 'https://example.test/zones/42.pmtiles*', {
    statusCode: 503,
    body: '',
  });
}

export function searchSituationFromHome(zone, profile) {
  stubSituationApis(zone);
  cy.visit('/');
  cy.get('#main-search-profile').select(profile);
  cy.get('#main-search-address').type('20 avenue de Ségur');
  cy.wait('@addressSearch');
  cy.get('[role="listbox"] [role="option"]').first().click();
  cy.get('[data-cy="MainRestrictionSearchSubmit"]').click();
  cy.wait('@zoneSearch');
  cy.location('pathname').should('equal', '/situation');
  cy.get('.situation-status').should('be.visible');
}

export function visitSituation(zone, profile) {
  stubSituationApis(zone);
  const address = encodeURIComponent(addressFeature.properties.label);

  cy.visit(
    `/situation?adresse=${address}&profil=${profile}&typeEau=AEP`,
  );
  cy.wait('@zoneSearch');
  cy.location('pathname').should('equal', '/situation');
  cy.get('.situation-status').should('be.visible');
}
