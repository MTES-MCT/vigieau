/* global cy, describe, expect, it */
import { addressFeature, situationZone, stubSituationApis } from '../support/public-situation';

function stubPointSituation() {
  const zone = situationZone({ id: 'point-zone', niveauGravite: 'alerte', restrictions: true });
  stubSituationApis(zone);
  cy.intercept('GET', '**/zones/v2?*', {
    statusCode: 200,
    body: { zones: [zone], availability: { AEP: { status: 'available' } } },
  }).as('pointZones');
}

describe('Liens de situation pour un point sur la carte', () => {
  it('utilise les coordonnées exactes zéro sans géocoder le libellé, y compris après rechargement', () => {
    stubPointSituation();
    cy.visit('/situation?profil=particulier&lon=0&lat=0&adresse=Point+sur+la+carte');
    cy.wait('@pointZones').then(({ request }) => {
      const params = new URL(request.url).searchParams;
      expect(params.get('lon')).to.equal('0');
      expect(params.get('lat')).to.equal('0');
      expect(params.has('commune')).to.equal(false);
    });
    cy.get('.situation-status').should('be.visible');
    cy.get('@addressSearch.all').should('have.length', 0);
    cy.location('search').should('include', 'lon=0').and('include', 'lat=0');
    cy.reload();
    cy.wait('@pointZones').then(({ request }) => {
      const params = new URL(request.url).searchParams;
      expect(params.get('lon')).to.equal('0');
      expect(params.get('lat')).to.equal('0');
    });
    cy.get('.situation-status').should('be.visible');
    cy.get('@addressSearch.all').should('have.length', 0);
  });

  it('préserve commune et précision du point sans remplacer ses coordonnées par une adresse voisine', () => {
    stubPointSituation();
    cy.visit(`/situation?${new URLSearchParams({ profil: 'exploitation', lon: '0.0000001', lat: '48.123456789', commune: '75056', adresse: 'Paris — Point sur la carte' })}`);
    cy.wait('@pointZones').then(({ request }) => {
      const params = new URL(request.url).searchParams;
      expect(Number(params.get('lon'))).to.equal(0.0000001);
      expect(Number(params.get('lat'))).to.equal(48.123456789);
      expect(params.get('commune')).to.equal('75056');
    });
    cy.get('.situation-status').should('be.visible');
    cy.get('@addressSearch.all').should('have.length', 0);
    cy.location('search').should('include', 'commune=75056');
  });

  it('ne transporte pas les coordonnées du point vers une nouvelle recherche d’adresse', () => {
    stubPointSituation();
    cy.visit('/situation?profil=particulier&lon=0&lat=0');
    cy.wait('@pointZones');
    cy.get('.situation-status').should('be.visible');
    cy.get('.situation-status .fr-breadcrumb a[href="/"]').click();
    cy.get('#main-search-address').type('20 avenue de Ségur');
    cy.wait('@addressSearch');
    cy.get('[role="listbox"] [role="option"]').first().click();
    cy.get('[data-cy="MainRestrictionSearchSubmit"]').click();
    cy.wait('@pointZones').then(({ request }) => {
      const params = new URL(request.url).searchParams;
      expect(Number(params.get('lon'))).to.equal(addressFeature.geometry.coordinates[0]);
      expect(Number(params.get('lat'))).to.equal(addressFeature.geometry.coordinates[1]);
    });
    cy.location('pathname').should('equal', '/situation');
    cy.location('search').should('not.include', 'lon=').and('not.include', 'lat=');
  });

  it('refuse un lien aux coordonnées invalides sans géocoder son adresse de secours', () => {
    stubPointSituation();
    cy.visit('/situation?lon=invalid&lat=48&adresse=Paris&commune=75056');
    cy.contains('Lien de situation invalide').should('be.visible');
    cy.contains('Les coordonnées de ce lien sont invalides ou incomplètes').should('be.visible');
    cy.get('@addressSearch.all').should('have.length', 0);
    cy.get('@pointZones.all').should('have.length', 0);
  });

  it('conserve la résolution des anciens liens contenant seulement une adresse', () => {
    stubPointSituation();
    cy.visit(`/situation?${new URLSearchParams({ profil: 'particulier', adresse: '20 Avenue de Ségur' })}`);
    cy.wait('@addressSearch');
    cy.wait('@pointZones');
    cy.get('.situation-status').should('be.visible');
    cy.location('search').should('not.include', 'lon=').and('not.include', 'lat=');
  });

  it('actualise adresse, restrictions et commune en passant d’un point AEP à un autre sans recharger', () => {
    stubPointSituation();
    cy.intercept('GET', '**/zones/v2?*', (request) => {
      const isSecondPoint = new URL(request.url).searchParams.get('lon') === '1';
      const zone = situationZone({ id: isSecondPoint ? 'point-b' : 'point-a', niveauGravite: 'alerte', restrictions: true });
      zone.usages = [{ ...zone.usages[0], nom: isSecondPoint ? 'Restriction du point B' : 'Restriction du point A' }];
      request.reply({ statusCode: 200, body: { zones: [zone], availability: { AEP: { status: 'available' } } } });
    }).as('changingPointZones');
    cy.visit('/situation?lon=0&lat=48&commune=75056&adresse=Point+A&typeEau=AEP');
    cy.wait('@changingPointZones');
    cy.get('.situation-status-header').should('contain.text', 'Point A');
    cy.contains('Restriction du point A').should('exist');
    cy.get('a[href="/donnees/commune/75056"]').should('exist');
    cy.get('#__nuxt').then(($root) => {
      const router = $root[0].__vue_app__.config.globalProperties.$router;
      return router.push('/situation?lon=1&lat=48&commune=75107&adresse=Point+B&typeEau=AEP');
    });
    cy.wait('@changingPointZones');
    cy.get('.situation-status-header').should('contain.text', 'Point B').and('not.contain.text', 'Point A');
    cy.contains('Restriction du point B').should('exist');
    cy.contains('Restriction du point A').should('not.exist');
    cy.get('a[href="/donnees/commune/75107"]').should('exist');
    cy.get('a[href="/donnees/commune/75056"]').should('not.exist');
    cy.title().should('contain', 'Point B').and('not.contain', 'Point A');
    cy.get('a[href^="https://www.facebook.com/sharer.php"]').should(($link) => {
      const sharedUrl = new URL(new URL($link.attr('href')).searchParams.get('u'));
      expect(sharedUrl.searchParams.get('lon')).to.equal('1');
      expect(sharedUrl.searchParams.get('adresse')).to.equal('Point B');
    });
    cy.get('@addressSearch.all').should('have.length', 0);
  });
});
