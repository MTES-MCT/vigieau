/* global cy, describe, it, expect */
const department = { id: 47, code: '47', nom: 'Lot-et-Garonne', zonesAlerte: [] };
const framework = {
  id: 470,
  numero: 'AC-TEST-LOAD',
  statut: 'publie',
  departements: [department],
  departementPilote: department,
  zonesAlerte: [],
  arretesRestriction: [],
  usages: [],
  dateDebut: '2026-01-01',
  dateFin: null,
  fichier: null,
};
const source = {
  id: 37731,
  numero: 'AR-TEST-LOAD',
  statut: 'a_valider',
  departement: department,
  arretesCadre: [framework],
  restrictions: [],
  dateDebut: null,
  dateFin: null,
  dateSignature: null,
  fichier: null,
};

function mockApplication(failingPath, failure) {
  const state = { fail: true, mutations: [], sourceReads: 0 };
  const paginated = { data: [], meta: { totalItems: 0, totalPages: 1, currentPage: 1, itemsPerPage: 9 }, links: {} };
  // All API requests are local fixtures, including retries and unexpected mutations.
  cy.intercept({ pathname: '/api/**' }, (request) => {
    const path = new URL(request.url).pathname;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      state.mutations.push({ method: request.method, path });
      request.reply({ statusCode: 405, body: {} });
      return;
    }
    if (path === failingPath) {
      state.sourceReads++;
      if (state.fail) {
        if (failure === 'network') {
          request.destroy();
        } else if (failure === 'timeout') {
          request.reply({ delay: 12000, body: path.includes('arrete-cadre') ? framework : source });
        } else {
          request.reply({ statusCode: failure, body: { statusCode: failure, message: 'Chargement refuse pour ce test.' } });
        }
        return;
      }
    }
    if (path === '/api/user/me') {
      request.reply({ email: 'operator@example.test', role: 'departement', roleDepartements: ['47'], checkRules: '2099-01-01' });
    } else if (path === '/api/departement') {
      request.reply([department]);
    } else if (path === '/api/arrete-cadre/470') {
      request.reply(framework);
    } else if (path === '/api/arrete-restriction/37731') {
      request.reply(source);
    } else if (path === '/api/arrete-cadre') {
      request.reply([framework]);
    } else if (path === '/api/parametres/47') {
      request.reply({ superpositionCommune: 'no_all', departement: department });
    } else if (path === '/api/zone-alerte/date') {
      request.reply('2026-09-07T00:00:00.000Z');
    } else if (path.endsWith('/search')) {
      request.reply(paginated);
    } else {
      request.reply([]);
    }
  });
  cy.intercept('https://**', { statusCode: 200, body: '' });
  return state;
}

function visitForm(path) {
  cy.visit(path, {
    onBeforeLoad(window) {
      window.WebGLRenderingContext = undefined;
    },
  });
}

const cases = [
  {
    name: 'restriction duplication',
    route: '/arrete-restriction/37731/duplication',
    api: '/api/arrete-restriction/37731',
    input: 'ArreteRestrictionFormNumeroInput',
    value: '',
  },
  {
    name: 'framework edition',
    route: '/arrete-cadre/470/edition',
    api: '/api/arrete-cadre/470',
    input: 'ArreteCadreFormNumeroInput',
    value: framework.numero,
  },
];

describe('Order form loading errors', () => {
  for (const scenario of cases) {
    for (const failure of [404, 500, 'network', 'timeout']) {
      it(`shows ${failure} and retries ${scenario.name} without writing any order`, () => {
        const state = mockApplication(scenario.api, failure);
        visitForm(scenario.route);
        cy.get('[data-cy=ArreteLoadError]', { timeout: 30000 }).should('be.visible');
        cy.get(`[data-cy=${scenario.input}]`).should('not.exist');
        cy.get('[data-cy=ArreteLoadPending]').should('not.exist');
        cy.then(() => {
          expect(state.mutations).to.deep.equal([]);
          state.fail = false;
        });
        cy.get('[data-cy=ArreteLoadRetry]').click();
        cy.get(`[data-cy=${scenario.input}]`, { timeout: 30000 }).should('have.value', scenario.value);
        cy.get('[data-cy=ArreteLoadError]').should('not.exist');
        cy.then(() => {
          expect(state.sourceReads).to.be.at.least(2);
          expect(state.mutations).to.deep.equal([]);
        });
      });
    }
  }

  it('does not create a fallback restriction draft when loading its selected framework fails', () => {
    const state = mockApplication('/api/arrete-cadre/470', 500);
    visitForm('/arrete-restriction/nouveau/edition?arretecadre=470');
    cy.get('[data-cy=ArreteLoadError]').should('be.visible');
    cy.get('[data-cy=ArreteRestrictionFormNumeroInput]').should('not.exist');
    cy.then(() => { state.fail = false; });
    cy.get('[data-cy=ArreteLoadRetry]').click();
    cy.get('[data-cy=ArreteRestrictionFormNumeroInput]').should('have.value', '');
    cy.contains('.fr-tag', framework.numero).should('be.visible');
    cy.then(() => expect(state.mutations).to.deep.equal([]));
  });

  it('retries a replacement source without confusing it with fresh creation', () => {
    const state = mockApplication('/api/arrete-restriction/37731', 404);
    visitForm('/arrete-restriction/nouveau/edition?arreterestriction=37731');
    cy.get('[data-cy=ArreteLoadError]').should('be.visible');
    cy.then(() => { state.fail = false; });
    cy.get('[data-cy=ArreteLoadRetry]').click();
    cy.get('[data-cy=ArreteRestrictionFormNumeroInput]').should('have.value', '');
    cy.get('[data-cy=ArreteRestrictionFormAbrogeInput]').should('have.value', source.numero);
    cy.then(() => expect(state.mutations).to.deep.equal([]));
  });

  for (const type of ['arrete-cadre', 'arrete-restriction']) {
    it(`keeps new ${type} creation working without an existing source`, () => {
      const state = mockApplication('/api/unexpected-source', 500);
      visitForm(`/${type}/nouveau/edition`);
      cy.get(`[data-cy=${type === 'arrete-cadre' ? 'ArreteCadre' : 'ArreteRestriction'}FormNumeroInput]`).should('have.value', '');
      cy.get('[data-cy=ArreteLoadError]').should('not.exist');
      cy.then(() => {
        expect(state.sourceReads).to.equal(0);
        expect(state.mutations).to.deep.equal([]);
      });
    });
  }

  it('returns to the list after a source loading failure', () => {
    const state = mockApplication('/api/arrete-restriction/37731', 404);
    visitForm('/arrete-restriction/37731/duplication');
    cy.get('[data-cy=ArreteLoadError]').should('be.visible');
    cy.contains('button', 'Retour à la liste').click();
    cy.location('pathname').should('equal', '/arrete-restriction');
    cy.then(() => expect(state.mutations).to.deep.equal([]));
  });
});
