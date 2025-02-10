describe('Carte des arrêtés cadres', () => {
  before(() => {
    cy.logout();
    cy.populateDb('arrete-cadre');
  });

  after(() => {
    cy.resetDb('arrete-cadre');
  });
  
  it(`Un arrêté cadre doit s'afficher correctement dans le listing`, () => {
    cy.devLogin(Cypress.env('mteUser'));
    cy.url().should('match', /arrete-cadre/);

    // Rechercher les bons arrêtés cadres via la recherche
    cy.searchAC('CYTEST_001');
    cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
    cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').eq(0).find('.fr-card__title').contains('CYTEST_001').should('exist');
    cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').eq(0).find('.fr-badge').contains('Brouillon').should('exist');
    cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').eq(0).find('.fr-card__desc').contains('Dep :').should('exist');
    cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').eq(0).find('.fr-card__detail').contains('2024-01-01').should('exist');
    // Checker les actions possibles
    // Checker arrêté abrogé
  });
  
  describe('En tant que département', () => {

    it(`Je doit pouvoir éditer un AC en brouillon ou publié`, () => {
      cy.devLogin(Cypress.env('departementUser'));
      // AC brouillon
      cy.searchAC('CYTEST_001');
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Modifier').should('exist');

      // AC à venir
      cy.searchAC('CYTEST_002');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Modifier').should('exist');

      // AC publié
      cy.searchAC('CYTEST_003');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Modifier').should('exist');

      // ACI pilote
      cy.searchAC('CYTEST_004');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Modifier').should('exist');

      // ACI pas pilote
      cy.searchAC('CYTEST_005');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Modifier').should('exist');

      // AC abrogé
      cy.searchAC('CYTEST_006', false);
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 0);
      cy.get('[data-cy=ArreteCadreListFilterAbroge]').first().click();
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Modifier').should('not.exist');
      
      // AC autre département
      cy.get('[data-cy=ArreteCadreListFilterPublie]').first().click();
      cy.searchAC('CYTEST_007', true, 'Haute-Corse');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Modifier').should('not.exist');
    });

    it(`Je doit pouvoir dupliquer n'importe quel AC`, () => {
      cy.devLogin(Cypress.env('departementUser'));
      // AC brouillon
      cy.searchAC('CYTEST_001');
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Dupliquer').should('exist');

      // AC à venir
      cy.searchAC('CYTEST_002');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Dupliquer').should('exist');

      // AC publié
      cy.searchAC('CYTEST_003');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Dupliquer').should('exist');

      // ACI pilote
      cy.searchAC('CYTEST_004');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Dupliquer').should('exist');

      // ACI pas pilote
      cy.searchAC('CYTEST_005');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Dupliquer').should('exist');

      // AC abrogé
      cy.searchAC('CYTEST_006', false);
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 0);
      cy.get('[data-cy=ArreteCadreListFilterAbroge]').first().click();
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Dupliquer').should('exist');

      // AC autre département
      cy.get('[data-cy=ArreteCadreListFilterPublie]').first().click();
      cy.searchAC('CYTEST_007', true, 'Haute-Corse');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Dupliquer').should('exist');
    });

    it(`Je doit pouvoir supprimer des AC brouillon ou bien des ACs qui n'ont aucun AR associé`, () => {
      cy.devLogin(Cypress.env('departementUser'));
      // AC brouillon
      cy.searchAC('CYTEST_001');
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Supprimer').should('exist');

      // AC à venir
      cy.searchAC('CYTEST_002');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Supprimer').should('exist');

      // AC publié
      cy.searchAC('CYTEST_003');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Supprimer').should('exist');

      // ACI pilote
      cy.searchAC('CYTEST_004');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Supprimer').should('exist');

      // ACI pas pilote
      cy.searchAC('CYTEST_005');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Supprimer').should('exist');

      // AC abrogé
      cy.searchAC('CYTEST_006', false);
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 0);
      cy.get('[data-cy=ArreteCadreListFilterAbroge]').first().click();
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Supprimer').should('exist');

      // AC autre département
      cy.get('[data-cy=ArreteCadreListFilterPublie]').first().click();
      cy.searchAC('CYTEST_007', true, 'Haute-Corse');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Supprimer').should('not.exist');
    });

    it(`Je doit pouvoir abroger des AC a venir ou publiés`, () => {
      cy.devLogin(Cypress.env('departementUser'));
      // AC brouillon
      cy.searchAC('CYTEST_001');
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Abroger').should('not.exist');

      // AC à venir
      cy.searchAC('CYTEST_002');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Abroger').should('exist');

      // AC publié
      cy.searchAC('CYTEST_003');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Abroger').should('exist');

      // ACI pilote
      cy.searchAC('CYTEST_004');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Abroger').should('exist');

      // ACI pas pilote
      cy.searchAC('CYTEST_005');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Abroger').should('exist');

      // AC abrogé
      cy.searchAC('CYTEST_006', false);
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 0);
      cy.get('[data-cy=ArreteCadreListFilterAbroge]').first().click();
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Abroger').should('not.exist');

      // AC autre département
      cy.get('[data-cy=ArreteCadreListFilterPublie]').first().click();
      cy.searchAC('CYTEST_007', true, 'Haute-Corse');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Abroger').should('not.exist');
    });
  });

  describe('En tant que MTE', () => {

    it(`Je doit pouvoir éditer n'importe quel AC`, () => {
      cy.devLogin(Cypress.env('mteUser'));
      // AC brouillon
      cy.searchAC('CYTEST_001');
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Modifier').should('exist');

      // AC à venir
      cy.searchAC('CYTEST_002');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Modifier').should('exist');

      // AC publié
      cy.searchAC('CYTEST_003');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Modifier').should('exist');

      // ACI pilote
      cy.searchAC('CYTEST_004');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Modifier').should('exist');

      // ACI pas pilote
      cy.searchAC('CYTEST_005');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Modifier').should('exist');

      // AC abrogé
      cy.searchAC('CYTEST_006', false);
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 0);
      cy.get('[data-cy=ArreteCadreListFilterAbroge]').first().click();
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Modifier').should('exist');

      // AC autre département
      cy.get('[data-cy=ArreteCadreListFilterPublie]').first().click();
      cy.searchAC('CYTEST_007');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Modifier').should('exist');
    });

    it(`Je doit pouvoir dupliquer n'importe quel AC`, () => {
      cy.devLogin(Cypress.env('mteUser'));
      // AC brouillon
      cy.searchAC('CYTEST_001');
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Dupliquer').should('exist');

      // AC à venir
      cy.searchAC('CYTEST_002');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Dupliquer').should('exist');

      // AC publié
      cy.searchAC('CYTEST_003');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Dupliquer').should('exist');

      // ACI pilote
      cy.searchAC('CYTEST_004');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Dupliquer').should('exist');

      // ACI pas pilote
      cy.searchAC('CYTEST_005');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Dupliquer').should('exist');

      // AC abrogé
      cy.searchAC('CYTEST_006', false);
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 0);
      cy.get('[data-cy=ArreteCadreListFilterAbroge]').first().click();
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Dupliquer').should('exist');

      // AC autre département
      cy.get('[data-cy=ArreteCadreListFilterPublie]').first().click();
      cy.searchAC('CYTEST_007');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Dupliquer').should('exist');
    });

    it(`Je doit pouvoir supprimer n'importe quel AC`, () => {
      cy.devLogin(Cypress.env('mteUser'));
      // AC brouillon
      cy.searchAC('CYTEST_001');
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Supprimer').should('exist');

      // AC à venir
      cy.searchAC('CYTEST_002');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Supprimer').should('exist');

      // AC publié
      cy.searchAC('CYTEST_003');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Supprimer').should('exist');

      // ACI pilote
      cy.searchAC('CYTEST_004');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Supprimer').should('exist');

      // ACI pas pilote
      cy.searchAC('CYTEST_005');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Supprimer').should('exist');

      // AC abrogé
      cy.searchAC('CYTEST_006', false);
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 0);
      cy.get('[data-cy=ArreteCadreListFilterAbroge]').first().click();
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Supprimer').should('exist');

      // AC autre département
      cy.get('[data-cy=ArreteCadreListFilterPublie]').first().click();
      cy.searchAC('CYTEST_007');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Supprimer').should('exist');
    });

    it(`Je doit pouvoir abroger des AC a venir ou publiés`, () => {
      cy.devLogin(Cypress.env('mteUser'));
      // AC brouillon
      cy.searchAC('CYTEST_001');
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Abroger').should('not.exist');

      // AC à venir
      cy.searchAC('CYTEST_002');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Abroger').should('exist');

      // AC publié
      cy.searchAC('CYTEST_003');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Abroger').should('exist');

      // ACI pilote
      cy.searchAC('CYTEST_004');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Abroger').should('exist');

      // ACI pas pilote
      cy.searchAC('CYTEST_005');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Abroger').should('exist');

      // AC abrogé
      cy.searchAC('CYTEST_006', false);
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 0);
      cy.get('[data-cy=ArreteCadreListFilterAbroge]').first().click();
      cy.get('[data-cy=ArreteCadreList] [data-cy=ArreteCadreListCard]').should('have.length', 1);
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Abroger').should('not.exist');

      // AC autre département
      cy.get('[data-cy=ArreteCadreListFilterPublie]').first().click();
      cy.searchAC('CYTEST_007');
      cy.get('[data-cy=ArreteCadreCardActionsBtn]').click();
      cy.get('.fr-card__actions__menu li').contains('Abroger').should('exist');
    });

  });
});