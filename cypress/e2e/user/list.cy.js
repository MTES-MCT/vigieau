describe('Liste des utilisateurs', () => {
  beforeEach(() => {
    cy.logout();
  });

  after(() => {
    cy.resetDb('user');
  });

  it(`La page utilisateur ne doit pas être accessible si on est pas connecté`, () => {
    cy.visit('/utilisateurs');
    cy.location('pathname').should('equal', '/connexion');
  });

  describe('En tant que département', () => {
    const userEmail = `CYTEST${Math.floor(Math.random() * 10000)}@example.com`;
    
    it(`Je doit pouvoir accéder aux listing des utilisateurs de mon département uniquement`, () => {
      cy.devLogin(Cypress.env('departementUser'));
      cy.location('pathname').should('equal', '/arrete-cadre');
      cy.get('.fr-header li a').contains('Utilisateurs').click();
      cy.location('pathname').should('equal', '/utilisateurs');

      cy.get('h1').contains('Les utilisateurs').should('exist');
      cy.get('.fr-table').contains(Cypress.env('departementUser')).should('exist');
      cy.get('.fr-table').contains(Cypress.env('departementAciUser')).should('not.exist');
      cy.get('.fr-table').contains(Cypress.env('mteUser')).should('not.exist');
    });

    it(`Je doit pouvoir créer / supprimer des utilisateurs sur mon département`, () => {
      cy.devLogin(Cypress.env('departementUser'));
      cy.visit('/utilisateurs');
      
      // Ajout d'un utilisateur
      cy.get('[data-cy=UserListAddUserButton]').click();
      cy.get('.fr-modal').contains('Ajout d\'un utilisateur').should('exist');

      cy.get('[data-cy=UserFormAddBtn]').click();
      cy.get('.fr-input-group--error').should('exist');
      
      cy.get('[data-cy=UserFormEmailInput]').type(userEmail);
      cy.get('[data-cy=UserFormFirstNameInput]').should('not.exist');
      cy.get('[data-cy=UserFormLastNameInput]').should('not.exist');
      cy.get('.fr-select').should('be.disabled');
      cy.get('.fr-select option:selected').should('have.text', 'Département')
      cy.get('[data-cy=UserFormRoleDepartementInput]').should('be.disabled');
      cy.get('[data-cy=UserFormRoleDepartementInput]').should('have.value', '2A');

      cy.get('[data-cy=UserFormAddBtn]').click();
      cy.get('.fr-table').contains(userEmail).should('exist');

      // Suppression d'un utilisateur
      cy.get('[data-cy=UserListEditBtn]').should('not.exist');
      cy.get('.fr-table').contains(userEmail).parent().find('[data-cy=UserListDeleteBtn]').click();
      cy.get('.fr-modal').contains('Suppression d\'un utilisateur').should('exist');
      cy.get('[data-cy=UserFormDeleteBtn]').click();
      cy.get('.fr-table').contains(userEmail).should('not.exist');
      // On reload la page pour être sûr
      cy.visit('/utilisateurs');
      cy.get('.fr-table').contains(userEmail).should('not.exist');
    })
  });

  describe('En tant que MTE', () => {
    const userEmail = `CYTEST${Math.floor(Math.random() * 10000)}@example.com`;
    const userRole = 'MTE';
    const userRoleDep = 'Département';
    const userDep = '13';

    it(`Je doit pouvoir accéder aux listing de tout les utilisateurs`, () => {
      cy.devLogin(Cypress.env('mteUser'));
      cy.location('pathname').should('equal', '/arrete-cadre');
      cy.get('.fr-header li a').contains('Utilisateurs').click();
      cy.location('pathname').should('equal', '/utilisateurs');

      cy.get('h1').contains('Les utilisateurs').should('exist');
      cy.get('.fr-table').contains(Cypress.env('departementUser')).should('exist');
      cy.get('.fr-table').contains(Cypress.env('departementAciUser')).should('exist');
      cy.get('.fr-table').contains(Cypress.env('mteUser')).should('exist');
    });

    it(`Je doit pouvoir créer / éditer / supprimer tout les utilisateurs`, () => {
      cy.devLogin(Cypress.env('mteUser'));
      cy.visit('/utilisateurs');

      // Ajout d'un utilisateur
      cy.get('[data-cy=UserListAddUserButton]').click();
      cy.get('.fr-modal').contains('Ajout d\'un utilisateur').should('exist');

      cy.get('[data-cy=UserFormAddBtn]').click();
      cy.get('.fr-input-group--error').should('exist');

      cy.get('[data-cy=UserFormEmailInput]').type(userEmail);
      cy.get('[data-cy=UserFormFirstNameInput]').should('not.exist');
      cy.get('[data-cy=UserFormLastNameInput]').should('not.exist');
      cy.get('.fr-select').should('not.be.disabled');
      cy.get('[data-cy=UserFormRoleDepartementInput]').should('not.exist');

      cy.get('[data-cy=UserFormAddBtn]').click();
      cy.get('.fr-input-group--error').should('exist');

      cy.get('.fr-select').select(userRole);
      cy.get('[data-cy=UserFormAddBtn]').click();
      cy.get('.fr-table').contains(userEmail).should('exist');
      
      // Modification d'un utilisateur
      cy.get('.fr-table').contains(userEmail).parent().find('[data-cy=UserListEditBtn]').click();
      cy.get('.fr-modal').contains('Modification d\'un utilisateur').should('exist');
      cy.get('[data-cy=UserFormEmailInput]').should('be.disabled');
      cy.get('[data-cy=UserFormFirstNameInput]').should('be.disabled');
      cy.get('[data-cy=UserFormLastNameInput]').should('be.disabled');
      cy.get('[data-cy=UserFormRoleDepartementInput]').should('not.exist');
      cy.get('.fr-select').select(userRoleDep);
      cy.get('[data-cy=UserFormRoleDepartementInput]').should('exist');
      cy.get('[data-cy=UserFormEditBtn]').click();
      cy.get('.fr-input-group--error').should('exist');
      cy.get('[data-cy=UserFormRoleDepartementInput]').type('test');
      cy.get('[data-cy=UserFormEditBtn]').click();
      cy.get('.fr-input-group--error').should('exist');
      cy.get('[data-cy=UserFormRoleDepartementInput]').clear();
      cy.get('[data-cy=UserFormRoleDepartementInput]').type(userDep);
      cy.get('[data-cy=UserFormEditBtn]').click();
      cy.get('.fr-table').contains(userEmail).parent().contains(userDep).should('exist');

      cy.get('.fr-table').contains(userEmail).parent().find('[data-cy=UserListEditBtn]').click();
      cy.get('.fr-select').select(userRole);
      cy.get('[data-cy=UserFormRoleDepartementInput]').should('not.exist');
      cy.get('[data-cy=UserFormEditBtn]').click();
      cy.get('.fr-table').contains(userEmail).parent().contains(userDep).should('not.exist');

      // Suppression d'un utilisateur
      cy.get('.fr-table').contains(userEmail).parent().find('[data-cy=UserListDeleteBtn]').click();
      cy.get('.fr-modal').contains('Suppression d\'un utilisateur').should('exist');
      cy.get('[data-cy=UserFormDeleteBtn]').click();
      cy.get('.fr-table').contains(userEmail).should('not.exist');
      // On reload la page pour être sûr
      cy.visit('/utilisateurs');
      cy.get('.fr-table').contains(userEmail).should('not.exist');
    })
  });
  
})