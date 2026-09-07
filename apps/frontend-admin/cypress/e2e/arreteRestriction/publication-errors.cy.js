const department = { id: 47, code: '47', nom: 'Lot-et-Garonne', subscriptions: 12 };
const theme = { id: 1, nom: 'Arroser' };
const zone = {
  id: 4701,
  code: 'TEST-47',
  nom: 'Zone de test',
  type: 'SUP',
  disabled: false,
  ressourceInfluencee: false,
  departement: department,
};

const usage = (overrides = {}) => ({
  id: 101,
  nom: 'Arrosage des jardins',
  thematique: theme,
  concerneParticulier: true,
  concerneEntreprise: false,
  concerneCollectivite: false,
  concerneExploitation: false,
  concerneEsu: true,
  concerneEso: false,
  concerneAep: false,
  descriptionVigilance: 'Usage autorise.',
  descriptionAlerte: 'Interdit entre 8 h et 20 h.',
  descriptionAlerteRenforcee: 'Interdit sauf exception.',
  descriptionCrise: 'Interdit.',
  ...overrides,
});

const page = (data) => ({
  data,
  meta: { totalItems: data.length, totalPages: 1, currentPage: 1, itemsPerPage: 9 },
  links: {},
});

function mockApplication(usages = [usage()], failures = {}) {
  const framework = {
    id: 470,
    numero: 'AC-TEST-47',
    statut: 'publie',
    dateDebut: '2026-01-01',
    dateFin: null,
    departements: [department],
    zonesAlerte: [zone],
    arretesRestriction: [],
    usages,
  };
  const source = {
    id: 37731,
    numero: 'AR-SOURCE-47',
    statut: 'abroge',
    dateDebut: '2026-08-01',
    dateFin: '2026-08-31',
    dateSignature: '2026-08-01',
    fichier: { nom: 'source.pdf', size: 100, url: '/source.pdf' },
    departement: department,
    arretesCadre: [framework],
    niveauGraviteSpecifiqueEap: null,
    ressourceEapCommunique: null,
    restrictions: [{
      id: 471,
      zoneAlerte: zone,
      arreteCadre: { id: framework.id },
      niveauGravite: 'alerte',
      isAep: false,
      communes: [],
      usages,
    }],
  };
  const requests = { save: [], check: [], publish: [] };

  // Every API call is answered locally; this suite must never contact a real backend.
  cy.intercept({ pathname: '/api/**' }, (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path === '/api/arrete-restriction') {
      request.alias = 'saveDraft';
      requests.save.push(request.body);
      if (failures.save) {
        request.reply({ statusCode: 400, body: { statusCode: 400, message: failures.save, error: 'Bad Request' } });
      } else {
        request.reply({
          ...request.body,
          id: 90001,
          restrictions: request.body.restrictions.map((restriction, index) => ({
            ...restriction,
            id: 1000 + index,
            usages: restriction.usages.map((item, usageIndex) => ({ ...item, id: 2000 + index * 100 + usageIndex })),
          })),
        });
      }
    } else if (request.method === 'POST' && path.endsWith('/check')) {
      request.alias = 'checkDraft';
      requests.check.push(request.body);
      request.reply(failures.check
        ? { statusCode: 400, body: { statusCode: 400, message: failures.check, error: 'Bad Request' } }
        : { errors: [], warnings: [] });
    } else if (request.method === 'POST' && path.endsWith('/publier')) {
      request.alias = 'publishDraft';
      requests.publish.push(request.body);
      request.reply({ statusCode: 400, body: { statusCode: 400, message: failures.publish || 'Publication refusee pour ce test.', error: 'Bad Request' } });
    } else if (path === '/api/user/me') {
      request.reply({
        email: 'ddt47@example.test',
        role: 'departement',
        roleDepartements: ['47'],
        checkRules: '2099-01-01',
      });
    } else if (path === '/api/departement') {
      request.reply([{ ...department, zonesAlerte: [zone] }]);
    } else if (path === '/api/thematique') {
      request.reply([theme]);
    } else if (path === '/api/usage') {
      request.reply(usages);
    } else if (path === '/api/zone-alerte/date') {
      request.reply('2026-09-07T00:00:00.000Z');
    } else if (path === '/api/arrete-restriction/search') {
      request.reply(page([source]));
    } else if (path === '/api/arrete-restriction/37731') {
      request.reply(source);
    } else if (path === '/api/arrete-cadre') {
      request.reply([framework]);
    } else if (path === '/api/parametres/47') {
      request.reply({ superpositionCommune: 'no_all', departement: department });
    } else if (path === '/api/usage_feedback/search') {
      request.reply(page([]));
    } else {
      request.reply([]);
    }
  });
  cy.intercept('https://**', { statusCode: 200, body: '' });
  return requests;
}

function openDuplicateFromHome() {
  const browserErrors = [];
  cy.visit('/', {
    onBeforeLoad(window) {
      window.WebGLRenderingContext = undefined;
      const reportError = window.console.error.bind(window.console);
      window.console.error = (...args) => {
        browserErrors.push(args.map(String).join(' '));
        reportError(...args);
      };
    },
  });
  cy.get('main a[href="/arrete-restriction"]').click();
  cy.location('pathname').should((path) => {
    expect(path, browserErrors.join('\n')).to.equal('/arrete-restriction');
  });
  cy.get('[data-cy=ArreteRestrictionCardActionsBtn]').click();
  cy.contains('.fr-menu__list a', 'Dupliquer').click();
  cy.location('pathname').should('equal', '/arrete-restriction/37731/duplication');
  cy.get('[data-cy=ArreteRestrictionFormNumeroInput]').type('AR-TEST-DUPLICATION');
  cy.get('[data-cy=ArreteRestrictionFormNextStepBtn]').click();
  cy.get('[data-cy=ArreteRestrictionFormNextStepBtn]').click();
  cy.get('[data-cy=ArreteRestrictionFormNextStepBtn]').click();
  cy.get('[data-cy=ArreteRestrictionFormPublishBtn]').should('be.visible');
}

function openPublicationModal() {
  cy.get('[data-cy=ArreteRestrictionFormPublishBtn]').click();
  cy.wait('@saveDraft');
  fillPublicationForm();
}

function fillPublicationForm() {
  cy.get('dialog[open] .fr-btn--close').should('be.focused');
  cy.get('[data-cy=PublishFormDateDebutInput]')
    .invoke('val', '2026-09-07')
    .trigger('input')
    .trigger('change')
    .should('have.value', '2026-09-07');
  cy.get('dialog[open] input[type=file]').selectFile({
    contents: Cypress.Buffer.from('%PDF-1.4\nPublication test\n%%EOF'),
    fileName: 'arrete-test.pdf',
    mimeType: 'application/pdf',
  }, { force: true });
  cy.get('[data-cy=PublishFormDateDebutInput]').should('have.value', '2026-09-07');
}

describe('Restriction publication errors with mocked APIs', () => {
  it('keeps save errors visible after navigating from the home layout and preserves the draft', () => {
    const message = 'Une zone ne fait plus partie de cet arrete cadre.';
    mockApplication([usage()], { save: message });
    openDuplicateFromHome();
    cy.clock(Date.now(), ['setTimeout', 'clearTimeout']);
    cy.get('[data-cy=ArreteRestrictionFormPublishBtn]').click();
    cy.wait('@saveDraft');
    cy.get('.alert-wrapper').should('be.visible').and('contain.text', message);
    cy.get('[data-cy=ArreteRestrictionErrorSummary]').should('be.visible').and('contain.text', message);
    cy.get('[data-cy=ArreteRestrictionFormPublishBtn]').should('not.be.disabled');
    cy.get('[data-cy=PublishFormPublishBtn]').should('not.exist');
    cy.tick(11000);
    cy.get('[data-cy=ArreteRestrictionErrorSummary]').should('be.visible').and('contain.text', message);
    cy.screenshot('publication-error-inline-desktop', { capture: 'viewport' });
    cy.get('[data-cy=ArreteRestrictionFormPreviousStepBtn]').click();
    cy.get('[data-cy=ArreteRestrictionFormPreviousStepBtn]').click();
    cy.get('[data-cy=ArreteRestrictionFormPreviousStepBtn]').click();
    cy.get('[data-cy=ArreteRestrictionFormNumeroInput]').should('have.value', 'AR-TEST-DUPLICATION');
    cy.location('pathname').should('equal', '/arrete-restriction/37731/duplication');
  });

  it('reports conflicting variants before sending a create request', () => {
    const requests = mockApplication([
      usage(),
      usage({ id: 102, descriptionAlerte: 'Autorise sans restriction.' }),
    ]);
    openDuplicateFromHome();
    cy.get('[data-cy=ArreteRestrictionFormPublishBtn]').click();
    cy.get('[data-cy=ArreteRestrictionErrorSummary]').should('be.visible').and('contain.text', 'Arrosage des jardins');
    cy.get('[data-cy=ArreteRestrictionConflictLink]').should('be.visible');
    cy.then(() => {
      expect(requests.save).to.have.length(0);
      expect(requests.publish).to.have.length(0);
    });
    cy.get('[data-cy=ArreteRestrictionFormPublishBtn]').should('not.be.disabled');
  });

  it('does not discard same-name variants when another usage is unchecked', () => {
    const requests = mockApplication([
      usage(),
      usage({ id: 102, concerneParticulier: false, concerneEntreprise: true, descriptionAlerte: 'Autorise pour les entreprises.' }),
      usage({ id: 103, nom: 'Nettoyage des cours' }),
    ]);
    openDuplicateFromHome();
    cy.contains('.fr-accordion__btn', 'Afficher les').click();
    cy.contains('.fr-checkbox-group', 'Nettoyage des cours').find('input[type=checkbox]').uncheck({ force: true });
    cy.get('[data-cy=ArreteRestrictionFormPublishBtn]').click();
    cy.wait('@saveDraft');
    cy.then(() => {
      const savedUsages = requests.save[0].restrictions[0].usages;
      expect(savedUsages).to.have.length(2);
      expect(savedUsages.map((item) => item.descriptionAlerte)).to.deep.equal([
        'Interdit entre 8 h et 20 h.',
        'Autorise pour les entreprises.',
      ]);
    });
    fillPublicationForm();
    cy.get('[data-cy=PublishFormPublishBtn]').click();
    cy.wait('@checkDraft');
    cy.then(() => {
      expect(requests.check[0].restrictions[0].usages.map((item) => item.id)).to.deep.equal([2000, 2001]);
    });
  });

  for (const phase of ['check', 'publish']) {
    it(`keeps ${phase} failures visible inside the publication modal and allows retry`, () => {
      const message = `Refus ${phase} explicite du serveur.`;
      const requests = mockApplication([usage()], { [phase]: message });
      openDuplicateFromHome();
      openPublicationModal();
      cy.get('[data-cy=PublishFormPublishBtn]').click();
      cy.wait(phase === 'check' ? '@checkDraft' : '@publishDraft');
      cy.get('dialog[open]').should('be.visible').and('contain.text', message);
      cy.get('[data-cy=ArreteRestrictionPublicationErrorSummary]').should('be.visible').and('contain.text', message);
      cy.get('[data-cy=PublishFormPublishBtn]').should('not.be.disabled');
      cy.get('[data-cy=PublishFormDateDebutInput]').should('have.value', '2026-09-07');
      cy.get('dialog[open] input[type=file]').then(($input) => {
        expect($input[0].files[0].name).to.equal('arrete-test.pdf');
      });
      cy.location('pathname').should('equal', '/arrete-restriction/37731/duplication');
      if (phase === 'check') {
        cy.then(() => expect(requests.publish).to.have.length(0));
      } else {
        cy.screenshot('publication-error-modal-desktop', { capture: 'viewport' });
        cy.viewport(390, 844);
        cy.get('[data-cy=ArreteRestrictionPublicationErrorSummary]').should('be.visible').and('contain.text', message);
        cy.get('[data-cy=PublishFormPublishBtn]').should('not.be.disabled');
        cy.screenshot('publication-error-modal-mobile', { capture: 'viewport' });
      }
    });
  }
});
/* global Cypress, cy, describe, expect, it */
