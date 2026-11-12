/* global cy, describe, it, expect */
const operationId = '44444444-4444-4444-8444-444444444444';
const row = {
  id: operationId,
  occurredAt: '2026-11-12T12:30:00.000Z',
  actor: { email: 'agent@example.test', firstName: 'Agent', role: 'departement' },
  action: 'arrete_restriction.update',
  actionLabel: 'Modification d’un arrêté',
  result: 'succeeded',
  resourceType: 'arrete_restriction',
  resourceId: '42',
  resourceLabel: 'AR-2026-42',
  territories: ['33'],
};

function mockApplication(options = {}) {
  const state = { queries: [], status: options.status || 200, details: [], writes: [], exports: [] };
  cy.intercept({ pathname: '/api/**' }, (request) => {
    const url = new URL(request.url);
    if (request.method !== 'GET') {
      state.writes.push(request.method);
      request.reply({ statusCode: 405, body: {} });
    } else if (url.pathname === '/api/user/me') {
      request.reply({ email: 'admin@example.test', role: options.role || 'mte', roleDepartements: ['33'], checkRules: '2099-01-01' });
    } else if (url.pathname === '/api/audit-events') {
      state.queries.push(Object.fromEntries(url.searchParams));
      if (state.status !== 200) request.reply({ statusCode: state.status, body: { message: 'Accès refusé' } });
      else
        request.reply({
          items: options.empty ? [] : [{ ...row, resourceLabel: url.searchParams.has('cursor') ? 'AR-2026-43' : row.resourceLabel }],
          nextCursor: url.searchParams.has('cursor') ? null : 'next-cursor',
        });
    } else if (url.pathname === `/api/audit-events/${operationId}`) {
      state.details.push(Object.fromEntries(url.searchParams));
      const more = url.searchParams.has('resourceCursor');
      request.reply({
        ...row,
        events: [{ id: 'event-1', occurredAt: row.occurredAt, phase: 'succeeded', action: row.action }],
        resources: [
          {
            id: more ? '2' : '1',
            resourceType: 'arrete_restriction',
            resourceId: '42',
            operation: 'UPDATE',
            before: { numero: 'Ancien numéro' },
            after: { numero: more ? 'Dernier changement' : '<img src=x onerror="window.auditXss=true">' },
            changedFields: ['numero'],
          },
        ],
        resourceCount: 2,
        nextResourceCursor: more ? null : 'more-resources',
        causality: [],
      });
    } else if (url.pathname === '/api/user') {
      request.reply([
        { email: 'emilie@example.test', firstName: 'Émilie', lastName: 'Dupont-Salé', role: 'departement', roleDepartements: ['33'] },
        { email: 'alice@example.test', firstName: 'Alice', lastName: 'Martin', role: 'departement', roleDepartements: ['75'] },
      ]);
    } else if (url.pathname === '/api/user/export') {
      state.exports.push(Object.fromEntries(url.searchParams));
      request.reply({
        headers: { 'content-type': 'text/csv; charset=utf-8' },
        body: 'Nom,Prénom,Email,Rôle\nDupont-Salé,Émilie,emilie@example.test,departement',
      });
    } else if (url.pathname.endsWith('/search')) {
      request.reply({ data: [], meta: { totalItems: 0, totalPages: 1, currentPage: 1, itemsPerPage: 9 }, links: {} });
    } else if (url.pathname === '/api/zone-alerte/date') request.reply('2026-11-12');
    else request.reply([]);
  });
  cy.intercept('https://**', { statusCode: 200, body: '' });
  return state;
}

function visitJournal() {
  cy.visit('/journal-activite', {
    onBeforeLoad(window) {
      window.WebGLRenderingContext = undefined;
    },
  });
}

describe('Journal d’activité des administrateurs', () => {
  it('filters, paginates and opens escaped changes without a mutation', () => {
    const state = mockApplication();
    visitJournal();
    cy.get('h1').should('contain', 'Journal d’activité');
    cy.get('[data-cy=AuditRow]').should('contain', 'AR-2026-42').and('contain', '13:30:00');
    cy.screenshot('audit-journal-desktop');
    cy.contains('button', 'Suivant').click();
    cy.get('[data-cy=AuditRow]').should('contain', 'AR-2026-43');
    cy.contains('button', 'Précédent').click();
    cy.get('[data-cy=AuditRow]').should('contain', 'AR-2026-42');
    cy.get('#audit-actor').type('agent+test@example.test');
    cy.get('#audit-action').select('user.update');
    cy.get('#audit-result').select('succeeded');
    cy.get('#audit-departement').type('33');
    cy.contains('button', 'Rechercher').click();
    cy.then(() => {
      expect(state.queries.at(-1)).to.include({
        actor: 'agent+test@example.test',
        action: 'user.update',
        result: 'succeeded',
        departement: '33',
      });
      expect(state.queries.at(-1)).not.to.have.property('cursor');
    });
    cy.get('[data-cy=AuditRow]').contains('button', 'Détail').click();
    cy.get('.audit-detail').should('contain.text', '<img src=x onerror="window.auditXss=true">');
    cy.get('.audit-detail img').should('not.exist');
    cy.get('.audit-changes').scrollIntoView().should('be.visible');
    cy.get('.audit-changes').contains('td', 'Ancien numéro').should('be.visible');
    cy.screenshot('audit-journal-detail', { capture: 'viewport' });
    cy.window().its('auditXss').should('not.exist');
    cy.contains('button', 'Afficher davantage de changements').click();
    cy.get('.audit-detail').should('contain', 'Dernier changement').and('contain', 'Ancien numéro');
    cy.contains('button', 'Afficher davantage de changements').should('not.exist');
    cy.then(() => {
      expect(state.details[1]).to.have.property('resourceCursor', 'more-resources');
      expect(state.writes).to.deep.equal([]);
    });
  });

  it('handles an unavailable journal and retries without showing stale rows', () => {
    const state = mockApplication({ status: 503 });
    visitJournal();
    cy.contains('Le journal est temporairement indisponible').should('be.visible');
    cy.get('[data-cy=AuditRow]').should('not.exist');
    cy.then(() => {
      state.status = 200;
    });
    cy.contains('button', 'Réessayer').click();
    cy.get('[data-cy=AuditRow]').should('have.length', 1);
  });

  it('shows a clear message when no matching action exists', () => {
    mockApplication({ empty: true });
    visitJournal();
    cy.contains('Aucune action ne correspond à ces filtres.').should('be.visible');
    cy.get('[data-cy=AuditRow]').should('not.exist');
  });

  it('does not reveal data when the API denies a stale MTE session', () => {
    mockApplication({ status: 403 });
    visitJournal();
    cy.contains('Votre accès n’est pas autorisé').should('be.visible');
    cy.get('[data-cy=AuditRow]').should('not.exist');
  });

  it('does not offer the journal to a departmental account', () => {
    const state = mockApplication({ role: 'departement' });
    visitJournal();
    cy.location('pathname').should('equal', '/');
    cy.get('a[href="/journal-activite"]').should('not.exist');
    cy.then(() => expect(state.queries).to.deep.equal([]));
  });

  it('keeps the selected user search in the audited server-side CSV export', () => {
    const state = mockApplication();
    cy.visit('/mon-departement');
    cy.contains('button', 'Utilisateurs').click();
    cy.get('input[placeholder="Rechercher un utilisateur"]').type('emilie');
    cy.contains('td', 'emilie@example.test').should('be.visible');
    cy.contains('td', 'alice@example.test').should('not.exist');
    cy.contains('button', 'Export CSV').click();
    cy.wrap(state.exports).should('have.length', 1);
    cy.then(() => expect(state.exports[0]).to.deep.equal({ search: 'emilie' }));
  });

  it('keeps the filter form usable on a narrow screen', () => {
    mockApplication();
    cy.viewport(390, 844);
    visitJournal();
    cy.get('#audit-actor').should('be.visible');
    cy.contains('button', 'Rechercher').scrollIntoView().should('be.visible');
    cy.get('[data-cy=AuditRow]').should('contain', 'AR-2026-42');
    cy.screenshot('audit-journal-mobile');
  });
});
