/* global cy, describe, it, expect, beforeEach */
import { csv2json } from 'json-2-csv';

const row = (date, provisional = false) => ({
  date, AEP: 'alerte', SUP: 'crise', SOU: null,
  ...(provisional ? { dataStatus: 'provisional', dataStatusReason: 'historic-recalculation' } : {}),
});
const commune = { code: '24547', nom: 'Terrasson-Lavilledieu' };

function visitWith(restrictions) {
  cy.intercept('GET', '**/data/commune/24547?*', (request) => {
    expect(request.query.includeProvisional).to.equal('true');
    request.reply({ body: { commune, restrictions } });
  }).as('statistics');
  cy.visit('/donnees/commune/24547?dateDebut=2026-07-10&dateFin=2026-09-01');
  cy.wait('@statistics');
}

describe('Historique communal provisoire', () => {
  beforeEach(() => {
    cy.clock(Date.UTC(2026, 8, 10, 12), ['Date']);
    cy.intercept('GET', '**/data', { body: { departements: [], regions: [], bassinsVersants: [] } });
    cy.intercept('GET', '**/data/status', { body: { status: 'ready', usable: true, currentFresh: true } });
    cy.intercept('GET', '**/zones/publication', { statusCode: 503, body: {} });
  });

  it('affiche les 52 jours retroactifs avec leur statut dans le graphique, le tableau et le CSV', () => {
    const restrictions = Array.from({ length: 54 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 6, 10 + index)).toISOString().slice(0, 10);
      return row(date, date >= '2026-07-11' && date <= '2026-08-31');
    });
    visitWith(restrictions);
    cy.contains('[role="status"]', "Recalcul de l'historique en cours")
      .should('be.visible').and('contain.text', '11/07/2026').and('contain.text', '31/08/2026').and('contain.text', '52 jours');
    cy.get('main canvas').should('have.length', 4);
    cy.get('main select[id$="-results-per-page"]').select('100');
    cy.get('main table tbody tr').should('have.length', 54);
    cy.get('main table').contains('th', 'Statut').should('exist');
    cy.get('main table tbody tr').contains('31/08/2026').closest('tr')
      .should('contain.text', 'Crise').and('contain.text', 'Provisoire (recalcul en cours)');
    cy.window().then((window) => {
      cy.spy(window.URL, 'createObjectURL').as('csvBlob');
      cy.stub(window.HTMLAnchorElement.prototype, 'click');
    });
    cy.contains('button', 'CSV').click();
    cy.get('@csvBlob').should('have.been.calledOnce').then((spy) => spy.firstCall.args[0].text()).then((csv) => csv2json(csv)).then((rows) => {
      expect(rows).to.have.length(54);
      expect(rows.find((item) => item.date === '2026-08-31')).to.deep.equal({
        date: '2026-08-31', AEP: 'alerte', SUP: 'crise', SOU: null, statut: 'Provisoire (recalcul en cours)',
      });
    });
  });

  it('signale les vraies lacunes sans les remplacer par une absence de restrictions', () => {
    visitWith([row('2026-07-10'), row('2026-07-11', true), row('2026-07-13', true)]);
    cy.contains('[role="status"]', 'Données manquantes sur la période')
      .should('be.visible').and('contain.text', '12/07/2026')
      .and('contain.text', 'Ces absences ne signifient pas une absence de restrictions.');
    cy.get('main table tbody tr').should('have.length', 3);
    cy.get('main table tbody').should('not.contain.text', '12/07/2026');
  });

  it('explique une selection sans observations et desactive les exports', () => {
    visitWith([]);
    cy.contains('Aucune donnée disponible pour cette sélection. Cela ne signifie pas une absence de restrictions.').should('be.visible');
    cy.contains('button', 'CSV').should('be.disabled');
    cy.contains('button', 'Télécharger le graphique').should('be.disabled');
    cy.contains("Recalcul de l'historique en cours").should('not.exist');
  });
});
