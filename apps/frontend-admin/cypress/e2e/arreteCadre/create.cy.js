describe('Création d\'un arrêtés cadres', () => {

  after(() => {
    cy.resetDb('arrete-cadre');
  });
  
  const acNumero = `CYTEST${Math.floor(Math.random() * 10000)}`;
  
  describe('En tant que département', () => {
    it(`Je peux créer un AC uniquement sur mon département`, () => {
      cy.devLogin(Cypress.env('departementUser')); 
      cy.get('[data-cy=ArreteCadreListAddBtn]').click();
      cy.location('pathname').should('equal', '/arrete-cadre/nouveau/edition');
      cy.get('h1').contains(`Création d'un arrêté cadre`).should('exist');
      
      // Général
      // Mon département doit être rempli automatiquement
      cy.get('.fr-highlight').contains('Corse-du-Sud').should('exist');
      cy.get('.fr-select').should('not.exist');
      cy.get('[data-cy=ArreteCadreFormDepartementsAutocomplete]').should('not.exist');
      
      // Je ne peux pas passer à l'étape suivante ni enregistrer sans avoir validé le formulaire courant
      cy.get('[data-cy=ArreteCadreFormNextStepBtn]').click();
      cy.get('.fr-input-group--error').should('exist');
      
      cy.get('[data-cy=ArreteCadreFormNumeroInput]').type(acNumero);
      cy.get('[data-cy=ArreteCadreFormNextStepBtn]').click();
      cy.get('.fr-input-group--error').should('not.exist');

      cy.get('[data-cy=ArreteCadreFormPreviousStepBtn]').click();
      cy.intercept({
        method: 'POST',
        url: '/api/arrete-cadre',
      }).as('acCreate');
      cy.get('[data-cy=ArreteCadreFormSaveBtn]').click();
      cy.wait('@acCreate');
      cy.get('.fr-alert--success').should('exist');
      cy.get('.fr-alert--success .fr-btn--close').first().click();
      cy.get('.fr-alert--success').should('not.exist');
      
      cy.get('[data-cy=ArreteCadreFormNextStepBtn]').click();

      // Règles
      cy.get('[data-cy=ArreteCadreFormNextStepBtn]').click();
      cy.get('.fr-input-group--error').should('exist');
      cy.get('[data-cy=ArreteCadreFormCommuneRadio] [type="radio"]').check('aep', {force: true});
      cy.get('[data-cy=ArreteCadreFormNextStepBtn]').click();
      cy.get('.fr-input-group--error').should('not.exist');
      
      // Zones
      cy.get('[data-cy=ArreteCadreFormNextStepBtn]').click();
      cy.get('.fr-input-group--error').should('exist');
      cy.get('.zone-alerte__title').contains('Corse-du-Sud').should('exist');
      cy.get('.zone-alerte__body [type="checkbox"]').first().check({force: true});
      cy.get('.zone-alerte__title').contains('1/2').should('exist');
      cy.get('.zone-alerte__title [type="checkbox"]').first().check({force: true});
      cy.get('.zone-alerte__title').contains('2/2').should('exist');
      cy.get('.zone-alerte__title [type="checkbox"]').first().uncheck({force: true});
      cy.get('.zone-alerte__title').contains('0/2').should('exist');
      cy.get('.zone-alerte__title [type="checkbox"]').first().check({force: true});
      cy.get('[data-cy=ArreteCadreFormNextStepBtn]').click();
      
      cy.intercept({
        method: 'PATCH',
        url: '/api/arrete-cadre/*',
      }).as('acUpdate');
      cy.get('[data-cy=ArreteCadreFormSaveBtn]').click();
      cy.wait('@acUpdate');
      cy.get('.fr-alert--success').should('exist');
      cy.get('.fr-alert--success .fr-btn--close').first().click();
      cy.get('.fr-alert--success').should('not.exist');
      
      // Usages
      cy.get('.fr-tabs__panel--selected .fr-table tbody td').should('not.exist');
      cy.get('[data-cy=ArreteCadreFormNextStepBtn]').click();
      cy.get('.fr-input-group--error').should('exist');
      cy.get('[data-cy=ArreteCadreFormUsagesAutocomplete] input').type('Arrosage des espaces verts');
      cy.get('ul li.list-item').should('exist');
      cy.get('ul li.list-item').first().click();
      cy.get('.usage-form-wrapper').should('exist');
      cy.get('[data-cy=ArreteCadreFormUsagesSaveBtn]').click();
      cy.get('.usage-form-wrapper .fr-input-group--error').should('exist');

      cy.get('[data-cy=UsageArreteCadreFormconcerneParticulierCheckbox] [type="checkbox"]').check({force: true});
      cy.get('[data-cy=UsageArreteCadreFormconcerneAepCheckbox] [type="checkbox"]').check({force: true});
      cy.get('[data-cy=UsageArreteCadreFormdescriptionCriseInput]').type('Description de la crise');
      cy.get('[data-cy=ArreteCadreFormUsagesSaveBtn]').click();
      cy.get('.usage-form-wrapper').should('not.exist');
      cy.get('.fr-tabs__panel--selected .fr-table tbody tr').should('have.length', 1);

      cy.get('[data-cy=ArreteCadreFormUsagesAutocomplete] input').type('Arrosage des espaces verts très spécifique');
      cy.get('ul li.list-item').should('have.length', 1);
      cy.get('ul li.list-item').last().click();
      cy.get('.fr-modal h1').contains('Création d\'un nouvel usage').should('exist');
      cy.get('[data-cy=UsageFormSaveBtn]').click();
      cy.get('.fr-modal .fr-input-group--error').should('exist');
      cy.get('[data-cy=UsageFormNameInput]').type('Arrosage des espaces verts très spécifique');
      cy.get('.fr-modal .fr-input-group--error').should('exist');
      cy.get('.fr-select').select('Arroser');
      cy.get('.fr-modal .fr-input-group--error').should('exist');
      cy.get('[data-cy=UsageFormconcerneParticulierCheckbox] [type="checkbox"]').check({force: true});
      cy.get('.fr-modal .fr-input-group--error').should('exist');
      cy.get('[data-cy=UsageFormconcerneAepCheckbox] [type="checkbox"]').check({force: true});
      cy.get('.fr-modal .fr-input-group--error').should('not.exist');
      cy.intercept({
        method: 'POST',
        url: '/api/usage',
      }).as('usageCreate');
      cy.get('[data-cy=UsageFormSaveBtn]').click();
      cy.wait('@usageCreate');
      cy.get('.usage-form-wrapper').should('exist');
      cy.get('[data-cy=ArreteCadreFormUsagesSaveBtn]').click();
      cy.get('.usage-form-wrapper .fr-input-group--error').should('exist');
      cy.get('[data-cy=UsageArreteCadreFormdescriptionCriseInput]').type('Description de la crise');
      cy.get('[data-cy=ArreteCadreFormUsagesSaveBtn]').click();
      cy.get('.usage-form-wrapper').should('not.exist');
      cy.get('.fr-tabs__panel--selected .fr-table tbody tr').should('have.length', 2);

      cy.intercept({
        method: 'PATCH',
        url: '/api/arrete-cadre/*',
      }).as('acUpdate');
      cy.get('[data-cy=ArreteCadreFormSaveBtn]').click();
      cy.wait('@acUpdate');
      cy.get('.fr-alert--success').should('exist');
      cy.get('.fr-alert--success .fr-btn--close').first().click();
      cy.get('.fr-alert--success').should('not.exist');
      
      cy.get('.fr-header__service').click();
      cy.location('pathname').should('equal', '/arrete-cadre');
      cy.searchAC(acNumero);
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard] .fr-card__title').click();
      cy.get('h1').contains(`Edition d'un arrêté cadre`).should('exist');
      cy.get('[data-cy=ArreteCadreFormNumeroInput]').should('have.value', acNumero);
      cy.get('.fr-highlight').contains('Corse-du-Sud').should('exist');
      cy.get('[data-cy=ArreteCadreFormNextStepBtn]').click();
      cy.get('[data-cy=ArreteCadreFormCommuneRadio] [type="radio"]').eq(0).should('not.be.checked');
      cy.get('[data-cy=ArreteCadreFormCommuneRadio] [type="radio"]').eq(1).should('be.checked');
      cy.get('[data-cy=ArreteCadreFormCommuneRadio] [type="radio"]').eq(2).should('not.be.checked');
      cy.get('[data-cy=ArreteCadreFormNextStepBtn]').click();
      cy.get('.zone-alerte__title').contains('2/2').should('exist');
      cy.get('[data-cy=ArreteCadreFormNextStepBtn]').click();
      cy.get('.fr-tabs__panel--selected .fr-table tbody tr').should('have.length', 2);
      cy.get('[data-cy=ArreteCadreFormNextStepBtn]').click();
      cy.get('.fr-tabs__panel--selected .fr-table tbody tr').should('have.length', 2);
      cy.get('[data-cy=ArreteCadreFormPublishBtn]').click();
      
      // Publication
      cy.get('.fr-modal h1').contains('Date de publication').should('exist');
      cy.get('[data-cy=PublishFormPublishBtn]').click();
      cy.get('.fr-modal .fr-input-group--error').should('exist');
      cy.get('[data-cy=PublishFormDateDebutInput]').type('2024-01-01');
      cy.fixture('guide_propluvia.pdf', null).as('guide');
      cy.get('input[type=file]').selectFile('@guide');
      cy.get('[data-cy=PublishFormPublishBtn]').click();

      // cy.wait();
      cy.location('pathname').should('equal', '/arrete-cadre');
      cy.searchAC(acNumero);
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').eq(0).find('.fr-badge').contains('En vigueur').should('exist');
      
      // Abrogation
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Abroger').click();
      cy.get('.fr-modal h1').contains(`Abroger l'arrêté ${acNumero}`).should('exist');
      cy.get('[data-cy=RepealFormRepealBtn]').click();
      cy.get('.fr-modal .fr-input-group--error').should('exist');
      cy.get('[data-cy=RepealFormDateDebutInput]').should('have.value', '2024-01-01');
      cy.get('[data-cy=RepealFormDateFinInput]').type('2023-01-01');
      cy.get('[data-cy=RepealFormRepealBtn]').click();
      cy.get('.fr-modal .fr-input-group--error').should('exist');
      cy.get('[data-cy=RepealFormDateFinInput]').type('2024-01-15');
      cy.intercept({
        method: 'GET',
        url: '/api/arrete-cadre/search*',
      }).as('acSearch');
      cy.get('[data-cy=RepealFormRepealBtn]').click();
      cy.wait('@acSearch');

      cy.searchAC(acNumero, false);
      cy.get('[data-cy=ArreteCadreListFilterAbroge]').first().click();
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard] .fr-card__title').contains(acNumero).should( 'exist' );

    });
  });

  describe('En tant que MTE', () => {
    it(`Je peux créer un AC sur n'importe quel département`, () => {
      // cy.devLogin(Cypress.env('mteUse'));
    });
  });
});