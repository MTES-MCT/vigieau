/* global cy, Cypress, describe, it, expect */
const commune = { id: 47001, code: '47001', nom: 'Agen', departement: { code: '47', nom: 'Lot-et-Garonne' } };
const order = {
  id: 47001,
  statut: 'a_valider',
  userFirstName: 'Test',
  userLastName: 'Municipal',
  userEmail: 'municipal@example.test',
  userPhone: '0612345678',
  dateDebut: '2026-11-01',
  dateFin: '2026-11-30',
  communes: [commune],
  fichier: { nom: 'arrete-test.pdf', url: '/arrete-test.pdf', size: 100 },
};

function mockApplication(response) {
  const state = { response, mutations: [], zoneReads: 0 };
  // Every API request, including save attempts, is answered with local fixtures.
  cy.intercept({ pathname: '/api/**' }, (request) => {
    const path = new URL(request.url).pathname;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      state.mutations.push({ method: request.method, path });
      request.reply({ ...order, statut: 'publie' });
    } else if (path === '/api/user/me') {
      request.reply({
        email: order.userEmail,
        role: 'commune',
        roleCommunes: [commune.code],
        checkRules: '2099-01-01',
      });
    } else if (path === `/api/arrete-municipal/${order.id}`) {
      request.reply(order);
    } else if (path === '/api/commune') {
      request.reply([commune]);
    } else if (path.endsWith('/search')) {
      request.reply({ data: [], meta: { totalItems: 0, totalPages: 1, currentPage: 1, itemsPerPage: 10 }, links: {} });
    } else {
      request.reply([]);
    }
  });
  cy.intercept({ pathname: '/api-vigieau/**' }, (request) => {
    expect(request.method).to.equal('GET');
    expect(new URL(request.url).searchParams.get('commune')).to.equal(commune.code);
    state.zoneReads++;
    request.alias = 'publicZones';
    if (state.response === 'network') {
      request.destroy();
    } else {
      request.reply(state.response);
    }
  });
  cy.intercept('https://**', { statusCode: 200, body: '' });
  cy.visit(`/arrete-municipal/${order.id}/edition`);
  cy.get('[data-cy=ArreteMunicipalFormPublishBtn]').should('be.visible').click();
  return state;
}

const bridgeSuite = Cypress.env('preprodPublicApiBridge') === true ? describe : describe.skip;
bridgeSuite('Preproduction public API bridge for municipal orders', () => {
  // Run against an admin build made with APP=regleau-front-preprod and VIGIEAU_PREPROD_PUBLIC_API_BRIDGE=true.
  // Opt in with --env preprodPublicApiBridge=true; ordinary admin builds do not enable the bridge.
  it('keeps the form after an expired session, offers a safe login tab and only saves after a successful explicit retry', () => {
    const state = mockApplication({ statusCode: 401, body: { error: 'preprod_auth_required' } });
    cy.get('[data-cy=ArreteMunicipalPublicApiError]').should('contain.text', 'connexion à la préproduction');
    cy.get('[data-cy=ArreteMunicipalPublicApiLogin]')
      .should('have.attr', 'href', 'https://vigieau.incubateur.net/_preprod/login?rd=%2F')
      .and('have.attr', 'target', '_blank');
    cy.get('dialog[open]').should('not.exist');
    cy.get('[data-cy=FormPhoneInput]').should('have.value', order.userPhone);
    cy.then(() => {
      expect(state.mutations).to.deep.equal([]);
      expect(state.zoneReads).to.equal(1);
      state.response = { statusCode: 200, body: [{ id: 1 }] };
    });
    cy.get('[data-cy=ArreteMunicipalPublicApiRetry]').click();
    cy.location('pathname').should('equal', '/arrete-municipal');
    cy.then(() => {
      expect(state.zoneReads).to.equal(2);
      expect(state.mutations).to.deep.equal([{ method: 'PATCH', path: `/api/arrete-municipal/${order.id}` }]);
    });
  });

  for (const scenario of [
    { name: 'access refusal', response: { statusCode: 403, body: { error: 'Forbidden' } }, message: 'refusé' },
    { name: 'network failure', response: 'network', message: 'momentanément indisponible' },
    { name: 'API unavailability', response: { statusCode: 503, body: {} }, message: 'momentanément indisponible' },
    {
      name: 'business 401',
      response: { statusCode: 401, body: { statusCode: 401, error: 'Unauthorized', message: 'Invalid token' } },
      message: 'momentanément indisponible',
    },
    { name: 'unrecognized 401', response: { statusCode: 401, body: {} }, message: 'momentanément indisponible' },
    { name: 'unexpected response', response: { statusCode: 200, body: '<html>Sign in</html>' }, message: 'momentanément indisponible' },
  ]) {
    it(`blocks the save and the no-order confirmation on ${scenario.name}`, () => {
      const state = mockApplication(scenario.response);
      cy.get('[data-cy=ArreteMunicipalPublicApiError]').should('contain.text', scenario.message);
      cy.get('[data-cy=ArreteMunicipalPublicApiLogin]').should('not.exist');
      cy.get('dialog[open]').should('not.exist');
      cy.get('[data-cy=ArreteMunicipalFormPublishBtn]').should('not.be.disabled');
      cy.then(() => expect(state.mutations).to.deep.equal([]));
    });
  }

  it('only shows the no-order confirmation for a successful empty list', () => {
    const state = mockApplication({ statusCode: 200, body: [] });
    cy.get('dialog[open]').should('contain.text', "Aucun arrêté préfectoral n'est en vigueur");
    cy.get('[data-cy=ArreteMunicipalPublicApiError]').should('not.exist');
    cy.then(() => expect(state.mutations).to.deep.equal([]));
    cy.contains('dialog[open] button', 'Confirmer').click();
    cy.location('pathname').should('equal', '/arrete-municipal');
    cy.then(() => expect(state.mutations).to.have.length(1));
  });

  it('preserves the existing overlapping-zone response', () => {
    const state = mockApplication({ statusCode: 409, body: { message: 'Overlapping zones' } });
    cy.location('pathname').should('equal', '/arrete-municipal');
    cy.then(() => expect(state.mutations).to.have.length(1));
  });
});
