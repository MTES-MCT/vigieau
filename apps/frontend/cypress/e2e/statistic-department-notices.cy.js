/* global cy, describe, it, expect, beforeEach */

const department = { code: '01', niveauGravite: 'alerte', niveauGraviteSup: 'alerte', niveauGraviteSou: null, niveauGraviteAep: null };
const row = (date, provisional = false) => ({
  date,
  departements: [department],
  ...(provisional ? { dataStatus: 'provisional', dataStatusReason: 'historic-recalculation' } : {}),
});
const updating = {
  status: 'degraded', usable: true, fresh: false, currentFresh: false,
  latestDate: '2026-09-08', currentPublishedDate: '2026-09-08',
};
const completeHistory = Array.from({ length: 70 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 6, 1 + index)).toISOString().slice(0, 10);
  return row(date, date >= '2026-07-11' && date <= '2026-08-31');
});

function typeSelector() {
  return cy.contains('label', "Type d'eau").invoke('attr', 'for').then((id) => cy.get(`[id="${id}"]`));
}

function notice() {
  return cy.get('[data-testid="statistic-series-status"]');
}

function dataAlerts() {
  return cy.get('main .background-blue .fr-alert');
}

describe('Messages statistiques departement regroupes', () => {
  beforeEach(() => {
    cy.clock(Date.UTC(2026, 8, 8, 12), ['Date']);
    cy.intercept('GET', '**/data', { body: { departements: [], regions: [], bassinsVersants: [] } });
    cy.intercept('GET', '**/zones/publication', { statusCode: 503, body: {} });
    cy.intercept('GET', '**/data/status', { body: updating }).as('status');
  });

  for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 375, height: 812 }]) {
    it(`${viewport.name}: un seul message pour actualisation et 52 jours provisoires`, () => {
      cy.viewport(viewport.width, viewport.height);
      cy.intercept('GET', '**/data/departement?*', { body: completeHistory }).as('statistics');
      cy.visit('/donnees/departement');
      cy.wait(['@statistics', '@status']);
      dataAlerts().should('have.length', 1);
      notice().should('contain.text', 'Données provisoires').and('contain.text', '11/07/2026').and('contain.text', '31/08/2026');
      cy.contains('Mise à jour en cours').should('not.exist');
      cy.contains('Données historiques sur l’eau potable limitées').should('not.exist');
      cy.get('main canvas').should('be.visible');
      cy.tick(1500);
      cy.document().should((document) => {
        expect(document.documentElement.scrollWidth).to.be.at.most(document.documentElement.clientWidth);
      });
      notice().scrollIntoView();
      cy.screenshot(`department-single-notice-${viewport.name}`, { capture: 'viewport' });
    });
  }

  it('rattache la limite eau potable aux observations affichees et au type choisi', () => {
    cy.intercept('GET', '**/data/status', { body: { ...updating, status: 'ready', fresh: true, currentFresh: true } });
    cy.intercept('GET', '**/data/departement?*', (request) => {
      request.reply({ body: request.query.dateDebut === '2023-01-01'
        ? [row('2023-01-01'), row('2023-01-02')]
        : [row('2026-09-07'), row('2026-09-08')] });
    }).as('statistics');
    cy.visit('/donnees/departement');
    cy.wait('@statistics');
    dataAlerts().should('not.exist');
    cy.get('#dateDebut').clear().type('2023-01-01');
    dataAlerts().should('not.exist');
    cy.contains('button', 'Calculer').click();
    cy.wait('@statistics');
    dataAlerts().should('have.length', 1);
    notice().should('contain.text', '28/04/2024');
    typeSelector().select('SUP');
    dataAlerts().should('not.exist');
    typeSelector().select('AEP');
    notice().should('contain.text', '28/04/2024');
  });

  it('ne signale pas une actualisation du jour sur une serie historique non concernee', () => {
    cy.intercept('GET', '**/data/departement?*', { body: [row('2026-06-01'), row('2026-06-02')] }).as('statistics');
    cy.visit('/donnees/departement');
    cy.wait(['@statistics', '@status']);
    dataAlerts().should('not.exist');
  });

  it('conserve une actualisation courante seule quand elle concerne la serie', () => {
    cy.intercept('GET', '**/data/departement?*', { body: [row('2026-09-07'), row('2026-09-08')] }).as('statistics');
    cy.visit('/donnees/departement');
    cy.wait(['@statistics', '@status']);
    dataAlerts().should('have.length', 1);
    notice().should('contain.text', 'Mise à jour en cours');
  });

  it('rafraichit le statut apres chargement effectif sans requete lors de la saisie', () => {
    let refreshed = false;
    let statusRequests = 0;
    cy.intercept('GET', '**/data/status', (request) => {
      statusRequests += 1;
      request.reply({ body: { ...updating, currentFresh: refreshed, fresh: refreshed, status: refreshed ? 'ready' : 'degraded' } });
    }).as('freshStatus');
    cy.intercept('GET', '**/data/departement?*', {
      body: [row('2026-09-07'), row('2026-09-08')],
    }).as('statistics');
    cy.visit('/donnees/departement');
    cy.wait(['@statistics', '@freshStatus']);
    notice().should('contain.text', 'Mise à jour en cours');
    cy.then(() => expect(statusRequests).to.equal(1));
    cy.get('#dateDebut').clear().type('2026-09-07');
    cy.then(() => {
      expect(statusRequests).to.equal(1);
      refreshed = true;
    });
    cy.contains('button', 'Calculer').click();
    cy.wait(['@statistics', '@freshStatus']);
    dataAlerts().should('not.exist');
    cy.then(() => expect(statusRequests).to.equal(2));
  });

  it('ne declare pas indisponibles des donnees chargees quand seul le statut echoue', () => {
    cy.intercept('GET', '**/data/status', { statusCode: 503, body: { status: 'unavailable', usable: false } }).as('failedStatus');
    cy.intercept('GET', '**/data/departement?*', { body: completeHistory }).as('statistics');
    cy.visit('/donnees/departement');
    cy.wait(['@statistics', '@failedStatus']);
    dataAlerts().should('have.length', 1);
    notice().should('contain.text', 'Données provisoires');
    cy.contains('Données temporairement indisponibles').should('not.exist');
    cy.get('main canvas').should('be.visible');
  });

  it('garde les vraies lacunes prioritaires dans un seul avertissement', () => {
    cy.intercept('GET', '**/data/departement?*', {
      body: [row('2026-07-01'), row('2026-07-02', true), row('2026-07-04', true)],
    }).as('statistics');
    cy.visit('/donnees/departement');
    cy.wait(['@statistics', '@status']);
    dataAlerts().should('have.length', 1);
    notice().should('have.class', 'fr-alert--warning').and('contain.text', 'Données manquantes');
    notice().find('details').should('not.have.attr', 'open');
    notice().contains('summary', 'Détails des données').click();
    notice().should('contain.text', '03/07/2026').and('contain.text', '02/07/2026').and('contain.text', '04/07/2026');
    cy.get('main table tbody tr').should('have.length', 3);
    cy.get('main table tbody').contains('03/07/2026').should('not.exist');
  });

  it('preserve une erreur de chargement unique avec reessai', () => {
    cy.intercept('GET', '**/data/status', { statusCode: 503, body: { status: 'unavailable', usable: false } });
    cy.intercept('GET', '**/data/departement?*', { statusCode: 503, body: {} }).as('statistics');
    cy.visit('/donnees/departement');
    cy.wait('@statistics');
    dataAlerts().should('have.length', 1).and('have.class', 'fr-alert--error');
    cy.contains('Données temporairement indisponibles').should('be.visible');
    cy.contains('button', 'Réessayer').should('be.visible');
    cy.get('main canvas').should('not.exist');
  });
});
