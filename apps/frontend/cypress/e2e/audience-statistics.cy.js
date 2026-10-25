/* global beforeEach, cy, describe, expect, it */

const emptyStatistics = {
  subscriptions: 0,
  profileRepartition: {},
  departementRepartition: {},
  regionRepartition: {},
  statsByDay: [{ date: '2026-10-24', visits: null, restrictionsSearch: null, arreteDownloads: null }],
};

function visitStatistics(body, statusCode = 200) {
  cy.intercept('GET', '**/statistics', { statusCode, body }).as('statistics');
  cy.visit('/stats');
  cy.wait('@statistics');
  cy.contains('h1', 'Statistiques de fréquentation').should('be.visible');
}

describe('Statistiques de fréquentation incomplètes', () => {
  beforeEach(() => {
    cy.intercept('GET', '**/data', { body: { bassinsVersants: [], regions: [], departements: [] } });
    cy.intercept('GET', 'https://tally.so/**', { statusCode: 200, body: '' });
    cy.intercept('GET', 'https://stats.beta.gouv.fr/**', { statusCode: 200, body: '' });
    cy.intercept('POST', '**/envelope/**', { statusCode: 200, body: '' });
    cy.intercept('GET', 'https://openmaptiles.data.gouv.fr/styles/**', {
      body: { version: 8, sources: {}, layers: [] },
    });
    cy.intercept('GET', 'https://openmaptiles.data.gouv.fr/data/decoupage-administratif.json', {
      body: { tilejson: '2.2.0', tiles: [], vector_layers: [{ id: 'departements' }, { id: 'regions' }] },
    });
  });

  it('affiche les valeurs manquantes sans erreur globale ni faux zéro', () => {
    cy.viewport(390, 844);
    visitStatistics({ ...emptyStatistics, subscriptions: null });
    cy.contains('Les données de fréquentation ne sont pas disponibles').should('be.visible');
    cy.contains("La répartition géographique des recherches n'est pas disponible").should('be.visible');
    cy.contains("La répartition des profils n'est pas disponible").should('be.visible');
    cy.contains('.fr-callout', 'nouveaux abonnements').should('contain.text', 'Donnée indisponible');
    cy.contains('.fr-callout', 'visites sur les jours renseignés').should('contain.text', 'Donnée indisponible');
    cy.get('main canvas').should('not.exist');
    cy.get('main').should('not.contain.text', 'NaN').and('not.contain.text', 'Infinity');
    cy.document().then(document => expect(document.documentElement.scrollWidth).to.be.at.most(document.documentElement.clientWidth));
  });

  it('garde les vrais zéros et ne calcule pas de pourcentage zéro divisé par zéro', () => {
    visitStatistics({
      ...emptyStatistics,
      profileRepartition: { particulier: 0 }, departementRepartition: { '01': 0 },
      statsByDay: [{ date: '2026-10-24', visits: 0, restrictionsSearch: 0, arreteDownloads: 0 }],
    });
    cy.contains('Aucune visite enregistrée').should('be.visible');
    cy.contains('.fr-callout', 'nouveaux abonnements').should('contain.text', '0');
    cy.contains('.fr-callout', 'visites sur la période affichée').should('contain.text', '0');
    cy.get('#search-statistics-tab-data').click();
    cy.get('#department-search-statistics-table').should('contain.text', 'Non disponible');
    cy.get('main').should('not.contain.text', 'NaN').and('not.contain.text', 'Infinity');
  });

  it('affiche une seule valeur géographique sans couleur invalide', () => {
    visitStatistics({
      ...emptyStatistics, departementRepartition: { '01': 5 }, regionRepartition: { '84': 5 },
      profileRepartition: { particulier: 5 },
      statsByDay: [{ date: '2026-10-24', visits: 5, restrictionsSearch: 5, arreteDownloads: null }],
    });
    cy.get('.map-legende-text').should('contain.text', '5 à 5');
    cy.get('#search-statistics-tab-data').click();
    cy.get('#department-search-statistics-table').should('contain.text', '100.00%');
  });

  it('précise la période réellement collectée et son ancienneté', () => {
    visitStatistics({
      ...emptyStatistics, period: { from: '2026-08-03', to: '2026-09-01' }, lastDataDate: '2026-09-01', stale: true, partial: true,
      statsByDay: [{ date: '2026-09-01', visits: 10, restrictionsSearch: null, arreteDownloads: null }],
    });
    cy.contains('Période du 03/08/2026 au 01/09/2026').should('be.visible');
    cy.contains('Dernières données disponibles : 01/09/2026').should('be.visible');
    cy.contains('Certaines mesures manquent sur cette période').should('be.visible');
    cy.get('main').should('not.contain.text', '30 derniers jours').and('not.contain.text', 'depuis le 10 Juillet');
  });

  it('permet de réessayer après une erreur API sans recharger toute la page', () => {
    let recovered = false;
    cy.intercept('GET', '**/statistics', request => request.reply(recovered
      ? { statusCode: 200, body: emptyStatistics }
      : { statusCode: 503, body: { message: 'indisponible' } })).as('statistics');
    cy.visit('/stats');
    cy.contains('Les statistiques de fréquentation sont momentanément indisponibles').should('be.visible');
    cy.then(() => { recovered = true; });
    cy.contains('button', 'Réessayer').click();
    cy.contains('Les données de fréquentation ne sont pas disponibles').should('be.visible');
    cy.contains('Les statistiques de fréquentation sont momentanément indisponibles').should('not.exist');
  });

  it('affiche un message et une relance pour une réponse vide', () => {
    visitStatistics(null);
    cy.contains('Les statistiques de fréquentation sont momentanément indisponibles').should('be.visible');
    cy.contains('button', 'Réessayer').should('be.enabled');
  });
});
