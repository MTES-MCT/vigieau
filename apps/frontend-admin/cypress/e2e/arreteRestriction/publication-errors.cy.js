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

function mockApplication(usages = [usage()], failures = {}, options = {}) {
  const frameworkUsages = options.frameworkUsages ?? usages;
  const sourceUsages = options.sourceUsages ?? usages;
  const zones = options.zones ?? [zone];
  const framework = {
    id: 470,
    numero: 'AC-TEST-47',
    statut: 'publie',
    dateDebut: '2026-01-01',
    dateFin: null,
    departements: [department],
    zonesAlerte: zones,
    arretesRestriction: [],
    usages: frameworkUsages,
  };
  const frameworks = [framework, ...(options.additionalFrameworks ?? [])];
  const applicationZones = frameworks.flatMap((item) => item.zonesAlerte);
  const source = {
    id: 37731,
    numero: 'AR-SOURCE-47',
    statut: options.sourceStatus ?? 'abroge',
    dateDebut: '2026-08-01',
    dateFin: '2026-08-31',
    dateSignature: '2026-08-01',
    fichier: { nom: 'source.pdf', size: 100, url: '/source.pdf' },
    departement: department,
    arretesCadre: frameworks,
    niveauGraviteSpecifiqueEap: null,
    ressourceEapCommunique: null,
    restrictions: options.restrictions ?? [{
      id: 471,
      zoneAlerte: zone,
      arreteCadre: { id: framework.id },
      niveauGravite: 'alerte',
      isAep: false,
      communes: [],
      usages: sourceUsages,
    }],
  };
  const requests = { save: [], check: [], publish: [], mutations: [] };

  // Every API call is answered locally; this suite must never contact a real backend.
  cy.intercept({ pathname: '/api/**' }, (request) => {
    const path = new URL(request.url).pathname;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      requests.mutations.push({ method: request.method, path });
    }
    if ((request.method === 'POST' && path === '/api/arrete-restriction') ||
        (request.method === 'PATCH' && ['/api/arrete-restriction/90001', '/api/arrete-restriction/37731'].includes(path))) {
      request.alias = 'saveDraft';
      requests.save.push(request.body);
      if (failures.save) {
        request.reply({ statusCode: 400, body: { statusCode: 400, message: failures.save, error: 'Bad Request' } });
      } else {
        request.reply({
          ...request.body,
          id: request.body.id ?? 90001,
          restrictions: request.body.restrictions.map((restriction, index) => ({
            ...restriction,
            id: restriction.id ?? 1000 + index,
            usages: restriction.usages.map((item, usageIndex) => ({ ...item, id: item.id ?? 2000 + index * 100 + usageIndex })),
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
      request.reply([{ ...department, zonesAlerte: applicationZones }]);
    } else if (path === '/api/thematique') {
      request.reply([theme]);
    } else if (path === '/api/usage') {
      request.reply(frameworks.flatMap((item) => item.usages));
    } else if (path === '/api/zone-alerte/date') {
      request.reply('2026-09-07T00:00:00.000Z');
    } else if (path === '/api/arrete-restriction/search') {
      request.reply(page([source]));
    } else if (path === '/api/arrete-restriction/37731') {
      request.reply(source);
    } else if (path === '/api/arrete-cadre') {
      request.reply(frameworks);
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

function openDuplicateFromHome(onZonesStep) {
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
  cy.location('pathname', { timeout: 30000 }).should((path) => {
    expect(path, browserErrors.join('\n')).to.equal('/arrete-restriction');
  });
  cy.get('[data-cy=ArreteRestrictionCardActionsBtn]').click();
  cy.contains('.fr-menu__list a', 'Dupliquer').click();
  cy.location('pathname', { timeout: 30000 }).should('equal', '/arrete-restriction/37731/duplication');
  cy.get('[data-cy=ArreteRestrictionFormNumeroInput]').type('AR-TEST-DUPLICATION');
  cy.get('[data-cy=ArreteRestrictionFormNextStepBtn]').click();
  cy.get('.fr-stepper__state').should('contain.text', '2 sur');
  cy.get('[data-cy=ArreteRestrictionFormNextStepBtn]').click();
  cy.get('.fr-stepper__state').should('contain.text', '3 sur');
  if (onZonesStep) {
    onZonesStep();
  }
  cy.get('[data-cy=ArreteRestrictionFormNextStepBtn]').click();
  cy.get('.fr-stepper__state').should('contain.text', '4 sur');
  cy.get('[data-cy=ArreteRestrictionFormPublishBtn]').should('be.visible');
}

function openExistingEdition() {
  cy.visit('/arrete-restriction/37731/edition', {
    onBeforeLoad(window) {
      window.WebGLRenderingContext = undefined;
    },
  });
  cy.get('[data-cy=ArreteRestrictionFormNextStepBtn]').click();
  cy.get('.fr-stepper__state').should('contain.text', '2 sur');
  cy.get('[data-cy=ArreteRestrictionFormNextStepBtn]').click();
  cy.get('.fr-stepper__state').should('contain.text', '3 sur');
  cy.get('[data-cy=ArreteRestrictionFormNextStepBtn]').click();
  cy.get('.fr-stepper__state').should('contain.text', '4 sur');
  cy.get('#arrete-restriction-zone-0').should('be.visible');
}

function assertResetPreviewLayout(mobile = false) {
  cy.get('dialog[open] .fr-modal__body, dialog[open] [data-cy=RestrictionUsageResetPreview]').each(($element) => {
    expect($element[0].scrollWidth).to.be.at.most($element[0].clientWidth + 1);
  });
  cy.get('dialog[open] .restriction-usage-reset-columns').children().then(($columns) => {
    const before = $columns[0].getBoundingClientRect();
    const after = $columns[1].getBoundingClientRect();
    if (mobile) {
      expect(after.top).to.be.at.least(before.bottom - 1);
    } else {
      expect(after.left).to.be.at.least(before.right - 1);
    }
  });
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

  it('preserves copied selections when framework variants become applicable at another severity', () => {
    const original = usage({ descriptionCrise: 'Consigne historique de crise.' });
    const alternative = usage({ id: 201, descriptionAlerte: '', descriptionCrise: 'Consigne actuelle de crise.' });
    const requests = mockApplication([original], {}, { frameworkUsages: [alternative] });
    openDuplicateFromHome();
    cy.get('#arrete-restriction-zone-0 .fr-accordion__btn').click();
    cy.get('#arrete-restriction-zone-0 input[type=checkbox]:checked').should('have.length', 1);
    cy.get('#arrete-restriction-zone-0 select').select('crise');
    cy.get('#arrete-restriction-zone-0 input[type=checkbox]:checked').should('have.length', 1);
    cy.get('#arrete-restriction-zone-0').should('contain.text', 'Consigne historique de crise.');
    cy.get('#arrete-restriction-zone-0 select').select('alerte');
    cy.get('#arrete-restriction-zone-0 input[type=checkbox]:checked').should('have.length', 1);
    cy.get('[data-cy=ArreteRestrictionFormPublishBtn]').click();
    cy.wait('@saveDraft');
    cy.then(() => {
      expect(requests.save[0].restrictions[0].niveauGravite).to.equal('alerte');
      expect(requests.save[0].restrictions[0].usages).to.have.length(1);
      expect(requests.save[0].restrictions[0].usages[0].descriptionCrise).to.equal(original.descriptionCrise);
    });
  });

  it('keeps true variants explicit and lets the user replace one without changing another zone', () => {
    const original = usage({ descriptionCrise: 'Consigne historique de crise.' });
    const alternative = usage({ id: 201, descriptionCrise: 'Consigne actuelle de crise.' });
    const secondZone = { ...zone, id: 4702, code: 'TEST-47-B', nom: 'Seconde zone' };
    const restrictions = [zone, secondZone].map((item, index) => ({
      id: 471 + index,
      zoneAlerte: item,
      arreteCadre: { id: 470 },
      niveauGravite: 'alerte',
      isAep: false,
      communes: [],
      usages: [{ ...original, id: original.id + index }],
    }));
    const requests = mockApplication([original], {}, {
      frameworkUsages: [alternative],
      zones: [zone, secondZone],
      restrictions,
    });
    openDuplicateFromHome();
    cy.get('#arrete-restriction-zone-0 .fr-accordion__btn').click();
    cy.get('#arrete-restriction-zone-0 .fr-checkbox-group').should('have.length', 2);
    cy.get('#arrete-restriction-zone-0 input[type=checkbox]:checked').should('have.length', 1);
    cy.get('#arrete-restriction-zone-0').should('contain.text', 'Consigne historique de crise.')
      .and('contain.text', 'Consigne actuelle de crise.');
    cy.get('#arrete-restriction-zone-0 [data-cy=RestrictionUsageVariantDetails] summary').click({ multiple: true });
    cy.get('#arrete-restriction-zone-0 [data-cy=RestrictionUsageVariantDetails]').should('have.attr', 'open');
    cy.screenshot('copied-usage-variants-desktop', { capture: 'fullPage' });
    cy.viewport(390, 844);
    cy.get('#arrete-restriction-zone-0').scrollIntoView();
    cy.screenshot('copied-usage-variants-mobile', { capture: 'fullPage' });
    cy.get('#arrete-restriction-zone-0 input[type=checkbox]:checked').uncheck({ force: true });
    cy.contains('dialog[open] button', 'Appliquer seulement').click();
    cy.get('#arrete-restriction-zone-0 .fr-checkbox-group').last().find('input[type=checkbox]').check({ force: true });
    cy.get('[data-cy=ArreteRestrictionFormPublishBtn]').click();
    cy.wait('@saveDraft');
    cy.then(() => {
      const saved = requests.save[0].restrictions;
      expect(saved[0].usages).to.have.length(1);
      expect(saved[0].usages[0].descriptionCrise).to.equal(alternative.descriptionCrise);
      expect(saved[1].usages).to.have.length(1);
      expect(saved[1].usages[0].descriptionCrise).to.equal(original.descriptionCrise);
    });
  });

  it('groups typographic equivalents without replacing or deleting selected source usages', () => {
    const original = usage({ nom: "Remplissage des fontaines d'ornement", descriptionCrise: 'Interdit.\nSauf exception.' });
    const equivalent = usage({
      id: 102,
      nom: 'Remplissage  des fontaines d’ornement',
      descriptionCrise: 'Interdit.\r\nSauf exception.',
    });
    const requests = mockApplication([original, equivalent], {}, {
      frameworkUsages: [{ ...equivalent, id: 201 }],
    });
    openDuplicateFromHome();
    cy.get('#arrete-restriction-zone-0 .fr-accordion__btn').click();
    cy.get('#arrete-restriction-zone-0 .fr-checkbox-group').should('have.length', 1);
    cy.get('#arrete-restriction-zone-0 input[type=checkbox]').should('be.checked');
    cy.get('#arrete-restriction-zone-0 select').select('crise');
    cy.get('[data-cy=ArreteRestrictionFormPublishBtn]').click();
    cy.wait('@saveDraft');
    cy.then(() => {
      const saved = requests.save[0].restrictions[0].usages;
      expect(saved).to.have.length(2);
      expect(saved.map((item) => item.nom)).to.deep.equal([original.nom, equivalent.nom]);
      expect(saved.map((item) => item.descriptionCrise)).to.deep.equal([
        original.descriptionCrise, equivalent.descriptionCrise,
      ]);
    });
  });

  it('does not restore explicitly unchecked usages after a severity round trip', () => {
    const requests = mockApplication();
    openDuplicateFromHome();
    cy.get('#arrete-restriction-zone-0 .fr-accordion__btn').click();
    cy.get('#arrete-restriction-zone-0 input[type=checkbox]').uncheck({ force: true });
    cy.get('#arrete-restriction-zone-0 select').select('crise');
    cy.get('#arrete-restriction-zone-0 select').select('alerte');
    cy.get('#arrete-restriction-zone-0 input[type=checkbox]:checked').should('not.exist');
    cy.get('[data-cy=ArreteRestrictionFormPublishBtn]').click();
    cy.wait('@saveDraft');
    cy.then(() => expect(requests.save[0].restrictions[0].usages).to.have.length(0));
  });

  it('initializes an added blank zone from the current framework instead of another zone history', () => {
    const original = usage({ descriptionCrise: 'Consigne historique de crise.' });
    const current = usage({ id: 201, descriptionCrise: 'Consigne actuelle de crise.' });
    const additionalZone = { ...zone, id: 4702, code: 'TEST-47-B', nom: 'Zone additionnelle' };
    const requests = mockApplication([original], {}, {
      frameworkUsages: [current],
      zones: [zone, additionalZone],
    });
    openDuplicateFromHome(() => {
      cy.contains('.fr-checkbox-group', 'Zone additionnelle').find('input[type=checkbox]').check({ force: true });
    });
    cy.get('#arrete-restriction-zone-1 select').select('alerte');
    cy.get('[data-cy=ArreteRestrictionFormPublishBtn]').click();
    cy.wait('@saveDraft');
    cy.then(() => {
      const saved = requests.save[0].restrictions;
      expect(saved).to.have.length(2);
      expect(saved[0].usages).to.have.length(1);
      expect(saved[0].usages[0].descriptionCrise).to.equal(original.descriptionCrise);
      expect(saved[1].usages).to.have.length(1);
      expect(saved[1].usages[0].descriptionCrise).to.equal(current.descriptionCrise);
    });
  });

  it('previews and resets only one zone to its framework without carrying historical usages back', () => {
    const targetZone = { ...zone, id: 2239, nom: 'La Bonnette', type: 'SOU' };
    const historical = Array.from({ length: 58 }, (_, index) => usage({
      id: 1000 + index,
      nom: `Ancienne mesure ${String(index + 1).padStart(2, '0')}`,
      concerneEsu: false,
      concerneEso: true,
    }));
    const authoritative = Array.from({ length: 17 }, (_, index) => usage({
      id: 2000 + index,
      nom: `Mesure AC ${String(index + 1).padStart(2, '0')}`,
      concerneEsu: false,
      concerneEso: true,
    }));
    const surface = usage({ id: 2100, nom: 'Usage superficiel exclu' });
    const additionalFrameworks = Array.from({ length: 4 }, (_, index) => ({
      id: 480 + index,
      numero: `AUTRE-AC-${index + 1}`,
      statut: 'publie',
      dateDebut: '2026-01-01',
      dateFin: null,
      departements: [department],
      zonesAlerte: [{ ...zone, id: 4800 + index, code: `TEST-48-${index}`, nom: `Autre zone ${index + 1}` }],
      arretesRestriction: [],
      usages: [usage({ id: 3000 + index, nom: `Mesure autre AC ${index + 1}` })],
    }));
    const restrictions = [{
      id: 471,
      zoneAlerte: targetZone,
      arreteCadre: { id: 470 },
      niveauGravite: 'alerte',
      isAep: false,
      communes: [],
      usages: historical,
    }, ...additionalFrameworks.map((framework, index) => ({
      id: 480 + index,
      zoneAlerte: framework.zonesAlerte[0],
      arreteCadre: { id: framework.id },
      niveauGravite: 'alerte',
      isAep: false,
      communes: [],
      usages: framework.usages,
    }))];
    const requests = mockApplication(historical, {}, {
      frameworkUsages: [...authoritative, surface],
      zones: [targetZone],
      additionalFrameworks,
      restrictions,
    });
    const originalRestrictions = JSON.parse(JSON.stringify(restrictions));
    openDuplicateFromHome();
    cy.get('#arrete-restriction-zone-0 .fr-accordion__btn').click();
    cy.get('#arrete-restriction-zone-0 input[type=checkbox]:checked').should('have.length', 58);
    cy.get('#arrete-restriction-zone-0 [data-cy=RestrictionUsageResetButton]').click();
    cy.get('[data-cy=RestrictionUsageResetDialog]:visible').should('contain.text', 'Avant : 58')
      .and('contain.text', 'Après : 17');
    cy.get('dialog[open] [data-cy=RestrictionUsageResetPreview]').should('contain.text', 'Ancienne mesure')
      .and('contain.text', 'Mesure AC');
    cy.then(() => expect(requests.save).to.have.length(0));
    cy.get('dialog[open] [data-cy=RestrictionUsageResetCancel]').click();
    cy.get('#arrete-restriction-zone-0 input[type=checkbox]:checked').should('have.length', 58);
    cy.get('#arrete-restriction-zone-0 [data-cy=RestrictionUsageResetButton]').click();
    cy.get('dialog[open] [data-cy=RestrictionUsageResetConfirm]').click();
    cy.get('#arrete-restriction-zone-0 input[type=checkbox]').should('have.length', 17);
    cy.get('#arrete-restriction-zone-0 input[type=checkbox]:checked').should('have.length', 17);
    cy.get('#arrete-restriction-zone-0').should('not.contain.text', 'Ancienne mesure')
      .and('not.contain.text', 'Usage superficiel exclu');
    cy.get('#arrete-restriction-zone-0 select').select('crise');
    cy.get('#arrete-restriction-zone-0 select').select('alerte');
    cy.get('#arrete-restriction-zone-0 input[type=checkbox]:checked').should('have.length', 17);
    cy.then(() => {
      expect(requests.save).to.have.length(0);
      expect(requests.check).to.have.length(0);
      expect(requests.publish).to.have.length(0);
      expect(requests.mutations).to.have.length(0);
      expect(restrictions).to.deep.equal(originalRestrictions);
    });
    cy.get('[data-cy=ArreteRestrictionFormPreviousStepBtn]').click();
    cy.get('[data-cy=ArreteRestrictionFormNextStepBtn]').click();
    cy.get('#arrete-restriction-zone-0').should('not.contain.text', 'Ancienne mesure');
    cy.get('#arrete-restriction-zone-0 input[type=checkbox]:checked').should('have.length', 17);
    cy.get('#arrete-restriction-zone-0 .fr-accordion__btn').should('contain.text', '17/17');
    cy.get('#arrete-restriction-zone-0').scrollIntoView();
    cy.get('[data-cy=ArreteRestrictionFormPublishBtn]').click();
    cy.wait('@saveDraft');
    cy.then(() => {
      const saved = requests.save[0];
      expect(saved.numero).to.equal('AR-TEST-DUPLICATION');
      expect(saved.arretesCadre.map((framework) => framework.id)).to.deep.equal([470, 480, 481, 482, 483]);
      expect(saved.restrictions).to.have.length(5);
      expect(saved.restrictions[0].usages.map((item) => item.nom)).to.deep.equal(authoritative.map((item) => item.nom));
      expect(saved.restrictions[0].usages.every((item) => item.id == null)).to.equal(true);
      saved.restrictions.slice(1).forEach((restriction, index) => {
        expect(restriction.zoneAlerte.id).to.equal(additionalFrameworks[index].zonesAlerte[0].id);
        expect(restriction.arreteCadre.id).to.equal(additionalFrameworks[index].id);
        expect(restriction.usages).to.have.length(1);
        expect(restriction.usages).to.deep.equal(additionalFrameworks[index].usages.map((item) => ({ ...item, id: null })));
      });
      expect(requests.mutations).to.deep.equal([{ method: 'POST', path: '/api/arrete-restriction' }]);
    });
    fillPublicationForm();
    cy.get('[data-cy=PublishFormPublishBtn]').click();
    cy.wait('@checkDraft');
    cy.then(() => {
      const checked = requests.check[0].restrictions[0].usages;
      expect(checked).to.have.length(17);
      expect(new Set(checked.map((item) => item.id)).size).to.equal(17);
      expect(checked.every((item) => Number.isInteger(item.id))).to.equal(true);
    });
  });

  it('restores the intended historical choice after crossing a severity with no applicable description', () => {
    const original = usage({ descriptionAlerte: '', descriptionCrise: 'Consigne historique de crise.' });
    const current = usage({ id: 201, descriptionCrise: 'Consigne actuelle de crise.' });
    const requests = mockApplication([original], { save: 'Echec simule pour conserver ce formulaire.' }, {
      frameworkUsages: [current],
      restrictions: [{
        id: 471,
        zoneAlerte: zone,
        arreteCadre: { id: 470 },
        niveauGravite: 'crise',
        isAep: false,
        communes: [],
        usages: [original],
      }],
    });
    openDuplicateFromHome();
    cy.get('#arrete-restriction-zone-0 .fr-accordion__btn').click();
    cy.get('#arrete-restriction-zone-0 select').select('alerte');
    cy.get('#arrete-restriction-zone-0 input[type=checkbox]:checked').should('not.exist');
    cy.get('[data-cy=ArreteRestrictionFormPublishBtn]').click();
    cy.wait('@saveDraft');
    cy.then(() => expect(requests.save[0].restrictions[0].usages).to.have.length(0));
    cy.get('#arrete-restriction-zone-0 select').select('crise');
    cy.get('#arrete-restriction-zone-0 input[type=checkbox]:checked').should('have.length', 1);
    cy.get('[data-cy=ArreteRestrictionFormPublishBtn]').click();
    cy.wait('@saveDraft');
    cy.then(() => {
      const saved = requests.save[1].restrictions[0].usages;
      expect(saved).to.have.length(1);
      expect(saved[0].descriptionCrise).to.equal(original.descriptionCrise);
    });
  });

  it('initializes a new zone at its first applicable severity even after an empty vigilance level', () => {
    const original = usage({ descriptionCrise: 'Consigne historique de crise.' });
    const current = usage({ id: 201, descriptionVigilance: '', descriptionCrise: 'Consigne actuelle de crise.' });
    const additionalZone = { ...zone, id: 4702, code: 'TEST-47-B', nom: 'Zone additionnelle' };
    const requests = mockApplication([original], {}, {
      frameworkUsages: [current],
      zones: [zone, additionalZone],
    });
    openDuplicateFromHome(() => {
      cy.contains('.fr-checkbox-group', 'Zone additionnelle').find('input[type=checkbox]').check({ force: true });
    });
    cy.get('#arrete-restriction-zone-1 [data-cy=RestrictionUsageResetButton]').should('be.disabled');
    cy.get('#arrete-restriction-zone-1 .fr-accordion__btn').click();
    cy.get('#arrete-restriction-zone-1 select').select('vigilance');
    cy.get('#arrete-restriction-zone-1 input[type=checkbox]:checked').should('not.exist');
    cy.get('#arrete-restriction-zone-1 select').select('alerte');
    cy.get('#arrete-restriction-zone-1 input[type=checkbox]:checked').should('have.length', 1);
    cy.get('[data-cy=ArreteRestrictionFormPublishBtn]').click();
    cy.wait('@saveDraft');
    cy.then(() => {
      const saved = requests.save[0].restrictions[1].usages;
      expect(saved).to.have.length(1);
      expect(saved[0].descriptionCrise).to.equal(current.descriptionCrise);
    });
  });

  it('shows a true before-after comparison and does not reuse a saved usage ID after its removal', () => {
    const original = usage({ descriptionAlerte: '', descriptionCrise: 'Consigne historique de crise.' });
    const current = usage({ id: 201, descriptionCrise: 'Consigne actuelle de crise.' });
    const requests = mockApplication([original], {}, {
      sourceStatus: 'a_valider',
      frameworkUsages: [current],
      restrictions: [{
        id: 471,
        zoneAlerte: zone,
        arreteCadre: { id: 470 },
        niveauGravite: 'crise',
        isAep: false,
        communes: [],
        usages: [original],
      }],
    });
    openExistingEdition();
    cy.get('#arrete-restriction-zone-0 [data-cy=RestrictionUsageResetButton]').click();
    cy.get('dialog[open] [data-cy=RestrictionUsageResetPreview] details').should('have.length', 1)
      .find('summary').click();
    cy.get('dialog[open] [data-cy=RestrictionUsageResetPreview]').should('contain.text', original.descriptionCrise)
      .and('contain.text', current.descriptionCrise).and('contain.text', 'Avant').and('contain.text', 'Après');
    assertResetPreviewLayout();
    cy.screenshot('usage-reset-before-after-desktop', { capture: 'viewport' });
    cy.viewport(390, 844);
    assertResetPreviewLayout(true);
    cy.get('dialog[open] [data-cy=RestrictionUsageResetConfirm]').should('be.visible');
    cy.screenshot('usage-reset-before-after-mobile', { capture: 'viewport' });
    cy.viewport(1280, 900);
    cy.get('dialog[open] [data-cy=RestrictionUsageResetCancel]').click();
    cy.then(() => expect(requests.save).to.have.length(0));
    cy.get('#arrete-restriction-zone-0 select').select('alerte');
    cy.get('[data-cy=ArreteRestrictionFormSaveBtn]').click();
    cy.wait('@saveDraft').its('request.method').should('equal', 'PATCH');
    cy.then(() => expect(requests.save[0].restrictions[0].usages).to.have.length(0));
    cy.get('#arrete-restriction-zone-0 select').select('crise');
    cy.get('[data-cy=ArreteRestrictionFormSaveBtn]').click();
    cy.wait('@saveDraft');
    cy.then(() => {
      const restored = requests.save[1].restrictions[0].usages;
      expect(restored).to.have.length(1);
      expect(restored[0].descriptionCrise).to.equal(original.descriptionCrise);
      expect(restored[0].id).to.equal(null);
    });
  });

  it('does not expose the reset command when editing an already published order', () => {
    const requests = mockApplication([usage()], {}, { sourceStatus: 'publie' });
    openExistingEdition();
    cy.get('[data-cy=RestrictionUsageResetButton]').should('not.exist');
    cy.then(() => {
      expect(requests.save).to.have.length(0);
      expect(requests.check).to.have.length(0);
      expect(requests.publish).to.have.length(0);
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
