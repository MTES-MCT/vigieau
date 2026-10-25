/* global after, cy, Cypress, describe, expect, it */

const selectedPanel = '.fr-tabs__panel--selected';
const nextStep = () => cy.get('[data-cy=ArreteCadreFormNextStepBtn]').click();
const saveUsage = () => cy.contains('dialog[open] .fr-btn', 'Enregistrer')
  .should(($button) => expect($button.text().trim()).to.equal('Enregistrer'))
  .click();

function fillUsage() {
  cy.get('dialog[open] input[data-cy=UsageFormconcerneParticulierCheckbox]').check({ force: true });
  cy.get('dialog[open] input[data-cy=UsageFormconcerneAepCheckbox]').check({ force: true });
  cy.get('dialog[open] [data-cy=UsageArreteCadreFormdescriptionCriseInput]').clear().type('Description de la crise');
}

describe("Création d'un arrêté cadre", () => {
  after(() => {
    cy.resetDb('arrete-cadre');
  });

  it('Un département peut enregistrer, compléter, publier puis abroger son arrêté', () => {
    const numero = `CYTEST_CREATE_${Date.now()}`;
    const customUsage = `Arrosage spécifique ${Date.now()}`;
    cy.devLogin(Cypress.env('departementUser'));
    cy.get('[data-cy=ArreteCadreListAddBtn]').click();
    cy.location('pathname').should('equal', '/arrete-cadre/nouveau/edition');
    cy.get('h1').should('contain.text', "Création d'un arrêté cadre");
    cy.get('.fr-highlight').should('contain.text', 'Corse-du-Sud');
    cy.get(`${selectedPanel} select`).should('not.exist');
    cy.get('[data-cy=ArreteCadreFormDepartementsAutocomplete]').should('not.exist');

    nextStep();
    cy.get(`${selectedPanel} .fr-input-group--error`).should('exist');
    cy.get('[data-cy=ArreteCadreFormNumeroInput]').type(numero);
    cy.intercept('POST', '**/api/arrete-cadre').as('create');
    cy.get('[data-cy=ArreteCadreFormSaveBtn]').click();
    cy.wait('@create').then(({ request, response }) => {
      expect(response.statusCode).to.equal(201);
      expect(request.body.departements.map((department) => department.code)).to.deep.equal(['2A']);
    });
    cy.get('.fr-alert--success').should('contain.text', 'Enregistrement réussi');

    nextStep();
    cy.get('.fr-stepper__state').should('contain.text', '2 sur 4');
    nextStep();
    cy.get('.fr-stepper__state').should('contain.text', '2 sur 4');
    cy.get('.zone-line').should('contain.text', 'Corse-du-Sud');
    cy.get('.zone-alerte__body input[type=checkbox]').first().check({ force: true });
    cy.get('.zone-line .fr-accordion__btn').should('contain.text', '1/2');
    cy.contains('.zone-line label', 'Tout sélectionner').click();
    cy.get('.zone-line .fr-accordion__btn').should('contain.text', '2/2');
    cy.contains('.zone-line label', 'Tout sélectionner').click();
    cy.get('.zone-line .fr-accordion__btn').should('contain.text', '0/2');
    cy.contains('.zone-line label', 'Tout sélectionner').click();
    nextStep();

    cy.get('.fr-stepper__state').should('contain.text', '3 sur 4');
    cy.get(`${selectedPanel} .fr-table tbody tr`).should('not.exist');
    nextStep();
    cy.get('.fr-stepper__state').should('contain.text', '3 sur 4');
    cy.get('[data-cy=ArreteCadreFormUsagesAutocomplete] input').type('Arrosage des espaces verts');
    cy.contains('ul li.list-item', 'Arrosage des espaces verts').click();
    cy.get('dialog[open] .fr-btn--close').should('be.focused');
    cy.get('dialog[open] [data-cy=UsageFormNameInput]').should('have.value', 'Arrosage des espaces verts');
    cy.get('dialog[open] [data-cy=UsageArreteCadreFormdescriptionCriseInput]')
      .focus().should('be.focused').clear().should('have.value', '');
    saveUsage();
    cy.get('dialog[open] .fr-input-group--error').should('exist');
    fillUsage();
    saveUsage();
    cy.get('dialog[open]').should('not.exist');
    cy.get(`${selectedPanel} .fr-table tbody tr`).should('have.length', 1);

    cy.contains(`${selectedPanel} button`, 'Créer un nouvel usage').click();
    cy.get('dialog[open] .fr-btn--close').should('be.focused');
    saveUsage();
    cy.get('dialog[open] .fr-input-group--error').should('exist');
    cy.get('dialog[open] [data-cy=UsageFormNameInput]').type(customUsage);
    cy.get('dialog[open] [data-cy=UsageFormThematiqueSelect]').select('Arroser');
    fillUsage();
    saveUsage();
    cy.get('dialog[open]').should('not.exist');
    cy.get(`${selectedPanel} .fr-table tbody tr`).should('have.length', 2);

    cy.intercept('PATCH', '**/api/arrete-cadre/*').as('save');
    cy.get('[data-cy=ArreteCadreFormSaveBtn]').click();
    cy.wait('@save').then(({ request, response }) => {
      expect(response.statusCode).to.equal(200);
      expect(request.body.zonesAlerte).to.have.length(2);
      expect(request.body.usages.map((usage) => usage.nom)).to.deep.equal(['Arrosage des espaces verts', customUsage]);
    });
    cy.contains('button', 'Retour à la liste').click();
    cy.location('pathname').should('equal', '/arrete-cadre');
    cy.searchAC(numero);
    cy.get('[data-cy=ArreteCadreListCard] .fr-card__title a').click();
    cy.get('[data-cy=ArreteCadreFormNumeroInput]').should('have.value', numero);
    nextStep();
    cy.get('.zone-line .fr-accordion__btn').should('contain.text', '2/2');
    nextStep();
    cy.get(`${selectedPanel} .fr-table tbody tr`).should('have.length', 2);
    cy.get(selectedPanel).should('contain.text', customUsage);
    nextStep();
    cy.get('.fr-stepper__state').should('contain.text', '4 sur 4');
    cy.get(selectedPanel).should('contain.text', 'Arrosage des espaces verts').and('contain.text', customUsage);
    cy.get('[data-cy=ArreteCadreFormPublishBtn]').click();
    cy.get('dialog[open] [data-cy=PublishFormPublishBtn]').click();
    cy.get('dialog[open] .fr-input-group--error').should('exist');
    cy.get('dialog[open] [data-cy=PublishFormDateDebutInput]').type('2024-01-01');
    cy.fixture('guide_propluvia.pdf', null).as('guide');
    cy.get('dialog[open] input[type=file]').selectFile('@guide');
    cy.intercept('POST', '**/api/arrete-cadre/*/publier').as('publish');
    cy.get('dialog[open] [data-cy=PublishFormPublishBtn]').click();
    cy.wait('@publish').its('response.statusCode').should('equal', 201);
    cy.location('pathname').should('equal', '/arrete-cadre');
    cy.searchAC(numero);
    cy.get('[data-cy=ArreteCadreListCard] .fr-badge').should('contain.text', 'En vigueur');

    cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
    cy.contains('.fr-card__actions__menu li', /^Abroger$/).click();
    cy.get('dialog[open] .fr-modal__title').should('contain.text', numero);
    cy.get('[data-cy=RepealFormRepealBtn]').click();
    cy.get('dialog[open] .fr-input-group--error').should('exist');
    cy.get('[data-cy=RepealFormDateDebutInput]').should('have.value', '2024-01-01');
    cy.get('[data-cy=RepealFormDateFinInput]').type('2023-01-01');
    cy.get('[data-cy=RepealFormRepealBtn]').click();
    cy.get('dialog[open] .fr-input-group--error').should('exist');
    cy.get('[data-cy=RepealFormDateFinInput]').clear().type('2024-01-15');
    cy.intercept('GET', '**/api/arrete-cadre/search*').as('repealed');
    cy.get('[data-cy=RepealFormRepealBtn]').click();
    cy.wait('@repealed');
    cy.searchAC(numero, false);
    cy.get('[data-cy=ArreteCadreListFilterAbroge]').first().click();
    cy.get('[data-cy=ArreteCadreListCard] .fr-card__title').should('contain.text', numero);
  });

  it('Le MTE peut créer un brouillon dans un autre département', () => {
    const numero = `CYTEST_MTE_${Date.now()}`;
    cy.devLogin(Cypress.env('mteUser'));
    cy.get('[data-cy=ArreteCadreListAddBtn]').click();
    cy.get('[data-cy=ArreteCadreFormNumeroInput]').type(numero);
    cy.get(`${selectedPanel} select`).select('2B - Haute-Corse');
    cy.intercept('POST', '**/api/arrete-cadre').as('createMte');
    cy.get('[data-cy=ArreteCadreFormSaveBtn]').click();
    cy.wait('@createMte').then(({ request, response }) => {
      expect(response.statusCode).to.equal(201);
      expect(request.body.departements.map((department) => department.code)).to.deep.equal(['2B']);
    });
    cy.contains('button', 'Retour à la liste').click();
    cy.searchAC(numero);
    cy.get('[data-cy=ArreteCadreListCard] .fr-card__desc').should('contain.text', 'Haute-Corse');
  });
});
