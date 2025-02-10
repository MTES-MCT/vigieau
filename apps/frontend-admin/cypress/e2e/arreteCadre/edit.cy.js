describe('Edition d\'un arrêtés cadres', () => {
  before(() => {
    // Création de l'AC en question
    cy.devLogin(Cypress.env('departementUser'));
    cy.get('[data-cy=ArreteCadreListAddBtn]').click();
    cy.get('[data-cy=ArreteCadreFormNumeroInput]').type(acNumero);
    cy.get('[data-cy=ArreteCadreFormNextStepBtn]').click();
    cy.get('[data-cy=ArreteCadreFormCommuneRadio] [type="radio"]').check('aep', {force: true});
    cy.get('[data-cy=ArreteCadreFormNextStepBtn]').click();
    cy.get('.zone-alerte__title [type="checkbox"]').first().check({force: true});
    cy.get('[data-cy=ArreteCadreFormNextStepBtn]').click();
    cy.get('[data-cy=ArreteCadreFormUsagesAutocomplete] input').type('Arrosage des espaces verts');
    cy.get('ul li.list-item').first().click();
    cy.get('[data-cy=UsageArreteCadreFormconcerneParticulierCheckbox] [type="checkbox"]').check({force: true});
    cy.get('[data-cy=UsageArreteCadreFormconcerneAepCheckbox] [type="checkbox"]').check({force: true});
    cy.get('[data-cy=UsageArreteCadreFormdescriptionCriseInput]').type('Description de la crise');
    cy.get('[data-cy=ArreteCadreFormUsagesSaveBtn]').click();
    cy.get('[data-cy=ArreteCadreFormNextStepBtn]').click();
    cy.get('[data-cy=ArreteCadreFormPublishBtn]').click();
    cy.get('[data-cy=PublishFormDateDebutInput]').type('2030-01-01');
    cy.fixture('guide_propluvia.pdf', null).as('guide');
    cy.get('input[type=file]').selectFile('@guide');
    cy.get('[data-cy=PublishFormPublishBtn]').click();
    cy.location('pathname').should('equal', '/arrete-cadre');
  })

  after(() => {
    cy.resetDb('arrete-cadre');
  });

  const acNumero = `CYTEST${Math.floor(Math.random() * 10000)}`;

  describe('En tant que département', () => {
    it(`Je peux éditer un AC uniquement sur mon département`, () => {
      cy.devLogin(Cypress.env('departementUser'));
      cy.searchAC(acNumero);
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').eq(0).find('.fr-badge').contains('Publication à venir').should('exist');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Modifier').click();
      cy.get('.fr-modal h1').contains(`Modification d’un arrêté cadre`).should('exist');
      cy.get('[data-cy=ConfirmEditFormBtn]').click();
      cy.get('h1').contains(`Edition d'un arrêté cadre`).should('exist');
    });
  });
});