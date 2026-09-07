/* global cy, describe, it, expect, beforeEach */

const amount = { vigilance: 0, alerte: 2, alerte_renforcee: 3, crise: 4 };
const area = [{ date: '2026-08-01', AEP: amount, ESU: amount, ESO: amount }];
const departments = [{
  date: '2026-08-01',
  departements: [{ code: '01', niveauGravite: 'alerte', niveauGraviteSup: 'alerte', niveauGraviteSou: null, niveauGraviteAep: null }],
}];
const commune = {
  commune: { code: '75107', nom: 'Paris 7e arrondissement' },
  restrictions: [{ date: '2026-08-01', AEP: null, SUP: 'alerte', SOU: null }],
};

function stubReferenceData() {
  cy.intercept('GET', '**/data', { body: { departements: [], regions: [], bassinsVersants: [] } });
  cy.intercept('GET', '**/data/status', { body: { status: 'ready', usable: true, currentFresh: true } });
  cy.intercept('GET', '**/zones/publication', { statusCode: 503, body: {} });
}

function typeSelector() {
  return cy.contains('label', "Type d'eau").invoke('attr', 'for').then((id) => cy.get(`[id="${id}"]`));
}

describe('Statistiques publiques apres erreurs de chargement', () => {
  beforeEach(stubReferenceData);

  for (const page of [
    { path: 'surface', endpoint: 'area', data: area },
    { path: 'departement', endpoint: 'departement', data: departments },
  ]) {
    it(`${page.path}: attend la reponse avant les filtres, puis affiche les vraies donnees`, () => {
      let release;
      const pending = new Promise((resolve) => { release = resolve; });
      cy.intercept('GET', `**/data/${page.endpoint}?*`, async (request) => {
        await pending;
        request.reply({ body: page.data });
      }).as('statistics');
      cy.visit(`/donnees/${page.path}`);
      typeSelector().should('be.disabled');
      cy.contains('button', 'Calculer').should('be.disabled');
      cy.get('main canvas').should('not.exist').then(() => release());
      cy.wait('@statistics');
      typeSelector().should('not.be.disabled').select(page.path === 'surface' ? 'ESO' : 'SOU');
      cy.get('main canvas').should('be.visible').should(($canvas) => {
        const canvas = $canvas[0];
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        expect(pixels.some((value, index) => index % 4 === 3 && value > 0), 'graphique non vide').to.equal(true);
      });
      cy.get('main table tbody tr').should('have.length', 1);
      cy.contains('button', 'CSV').should('not.be.disabled');
      cy.get('#dateDebut').clear().type('2026-08-01');
      cy.contains('button', 'CSV').should('be.disabled');
      cy.contains('button', 'Calculer').click();
      cy.wait('@statistics');
      cy.contains('button', 'CSV').should('not.be.disabled');
      cy.screenshot(`statistics-${page.path}-desktop`, { capture: 'viewport' });
      cy.viewport(375, 812);
      cy.get('main canvas').should('be.visible');
      cy.document().should((document) => {
        expect(document.documentElement.scrollWidth).to.be.at.most(document.documentElement.clientWidth);
      });
      cy.screenshot(`statistics-${page.path}-mobile`, { capture: 'viewport' });
    });

    it(`${page.path}: refuse une reponse incomplete et permet de reessayer`, () => {
      let successful = false;
      cy.intercept('GET', `**/data/${page.endpoint}?*`, (request) => {
        request.reply({ body: successful ? page.data : [{ date: '2026-08-01' }] });
      }).as('statistics');
      cy.visit(`/donnees/${page.path}`);
      cy.wait('@statistics');
      cy.contains('Données temporairement indisponibles').should('be.visible');
      cy.get('main canvas').should('not.exist');
      cy.get('main table').should('not.exist');
      cy.then(() => { successful = true; });
      cy.contains('button', 'Réessayer').click();
      cy.wait('@statistics');
      cy.get('main canvas').should('be.visible');
      cy.get('main table tbody tr').should('have.length', 1);
    });

    it(`${page.path}: distingue une panne HTTP des donnees vides`, () => {
      let available = false;
      cy.intercept('GET', `**/data/${page.endpoint}?*`, (request) => {
        request.reply(available ? { body: [] } : { statusCode: 503, body: { message: 'Unavailable' } });
      }).as('statistics');
      cy.visit(`/donnees/${page.path}`);
      cy.contains('Données temporairement indisponibles').should('be.visible');
      cy.get('main canvas').should('not.exist');
      cy.then(() => { available = true; });
      cy.contains('button', 'Réessayer').click();
      cy.contains('Aucune donnée disponible pour cette sélection.').should('be.visible');
      cy.get('main canvas').should('not.exist');
      cy.contains('button', 'CSV').should('be.disabled');
    });
  }

  it('commune: refuse une reponse vide et recharge les donnees apres reessai', () => {
    let successful = false;
    cy.intercept('GET', '**/data/commune/75107*', (request) => {
      request.reply(successful ? { body: commune } : { statusCode: 204 });
    }).as('statistics');
    cy.visit('/donnees/commune/75107');
    cy.contains('Les données de cette commune ne peuvent pas être chargées').should('be.visible');
    cy.get('main canvas').should('not.exist');
    cy.then(() => { successful = true; });
    cy.contains('button', 'Réessayer').click();
    cy.get('main canvas').should('have.length', 4);
    cy.get('main table tbody tr').should('have.length', 1);
  });

  it('garde le theme clair quand le navigateur interdit localStorage', () => {
    cy.intercept('GET', '**/data/area?*', { body: area });
    cy.visit('/donnees/surface', {
      onBeforeLoad(window) {
        Object.defineProperty(window, 'localStorage', { get() {
          throw new window.DOMException('Storage unavailable', 'SecurityError');
        } });
      },
    });
    cy.get('html').should('have.attr', 'data-fr-theme', 'light');
    cy.get('main canvas').should('be.visible');
  });

  it('signale les echecs CSV sans rejet de promesse non gere', () => {
    cy.intercept('GET', '**/data/area?*', { body: area });
    cy.visit('/donnees/surface');
    cy.get('main canvas').should('be.visible');
    cy.window().then((window) => {
      cy.stub(window.URL, 'createObjectURL').throws(new window.Error('Download unavailable'));
    });
    cy.contains('button', 'CSV').click();
    cy.contains('La génération du fichier CSV a échoué.').should('be.visible');
    cy.contains('button', 'CSV').should('not.be.disabled');
  });
});
