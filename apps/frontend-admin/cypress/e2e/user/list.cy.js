/* global Cypress, cy, describe, it, beforeEach, after */

const emails = [];
const testEmail = () => {
  const email = 'cytest_' + Cypress._.random(1000000000) + '@example.com';
  emails.push(email);
  return email;
};
const departmentInput = 'input[data-cy=UserFormRoleDepartementInput], [data-cy=UserFormRoleDepartementInput] input';
const userRow = (email) => cy.contains('.fr-table td', email).closest('tr');

function showUsers(fromMenu = false) {
  if (fromMenu) {
    cy.get('.fr-header__tools-links').contains('a', 'Mon compte').click();
    cy.get('#account-menu-list').contains('a', 'Mon département').click();
  } else {
    cy.visit('/mon-departement');
  }
  cy.location('pathname').should('equal', '/mon-departement');
  cy.contains('[role=tab]', 'Utilisateurs').click();
  cy.contains('h1', 'Utilisateurs').should('be.visible');
}

function selectDepartment(code) {
  cy.get(departmentInput).should('have.length', 1).clear().type(code);
  cy.get(departmentInput).closest('.search-autocomplete').contains('li', code + ' - ').should('exist');
  cy.get(departmentInput).blur().focus();
  cy.get(departmentInput).closest('.search-autocomplete').contains('li', code + ' - ').should('be.visible').click();
  cy.contains('.fr-modal .fr-tag', code + ' - ').should('be.visible');
}

function deleteUser(email) {
  userRow(email).find('[data-cy=UserListDeleteBtn]').click();
  cy.contains('.fr-modal', "Suppression d'un utilisateur").should('be.visible');
  cy.get('[data-cy=UserFormDeleteBtn]').click();
  cy.contains('.fr-table td', email).should('not.exist');
  showUsers();
  cy.contains('.fr-table td', email).should('not.exist');
}

describe('Liste des utilisateurs', () => {
  beforeEach(() => cy.logout());

  after(() => {
    cy.devLogin(Cypress.env('mteUser'));
    for (const email of emails) {
      cy.request({
        method: 'DELETE',
        url: Cypress.env('apiUrl').replace(/\/$/, '') + '/user/' + encodeURIComponent(email),
      }).its('status').should('equal', 200);
    }
  });

  it('refuse la page utilisateur sans authentification', () => {
    cy.visit('/mon-departement');
    cy.location('pathname').should('equal', '/connexion');
  });

  it('montre au DDT les utilisateurs de son departement uniquement', () => {
    cy.devLogin(Cypress.env('departementUser'));
    showUsers(true);
    cy.contains('.fr-table td', Cypress.env('departementUser')).should('exist');
    cy.contains('.fr-table td', Cypress.env('departementAciUser')).should('not.exist');
    cy.contains('.fr-table td', Cypress.env('mteUser')).should('not.exist');
  });

  it('permet au DDT de creer et supprimer un utilisateur sur son departement', () => {
    const email = testEmail();
    cy.devLogin(Cypress.env('departementUser'));
    showUsers();
    cy.get('[data-cy=UserListAddUserButton]').click();
    cy.contains('.fr-modal', "Ajout d'un utilisateur").should('be.visible');
    cy.get('[data-cy=UserFormAddBtn]').click();
    cy.get('.fr-input-group--error').should('exist');
    cy.get('[data-cy=UserFormEmailInput]').type(email);
    cy.get('[data-cy=UserFormFirstNameInput]').should('not.exist');
    cy.get('[data-cy=UserFormLastNameInput]').should('not.exist');
    cy.get('#role').should('be.disabled').find('option:selected').should('have.text', 'Département');
    cy.contains('.fr-modal .fr-tag', '2A - ').should('be.visible');
    cy.get(departmentInput).type('2B');
    cy.get(departmentInput).closest('.search-autocomplete').find('li').should('not.exist');
    cy.get(departmentInput).clear();
    cy.get('[data-cy=UserFormAddBtn]').click();
    userRow(email).should('contain.text', '2A');
    cy.get('[data-cy=UserListEditBtn]').should('not.exist');
    deleteUser(email);
  });

  it('montre au MTE les utilisateurs de tous les departements', () => {
    cy.devLogin(Cypress.env('mteUser'));
    showUsers(true);
    for (const key of ['departementUser', 'departementAciUser', 'mteUser']) {
      cy.contains('.fr-table td', Cypress.env(key)).should('exist');
    }
  });

  it('permet au MTE de creer, modifier les droits multi-DDT et supprimer un utilisateur', () => {
    const email = testEmail();
    cy.devLogin(Cypress.env('mteUser'));
    showUsers();
    cy.get('[data-cy=UserListAddUserButton]').click();
    cy.contains('.fr-modal', "Ajout d'un utilisateur").should('be.visible');
    cy.get('[data-cy=UserFormAddBtn]').click();
    cy.get('.fr-input-group--error').should('exist');
    cy.get('[data-cy=UserFormEmailInput]').type(email);
    cy.get('[data-cy=UserFormFirstNameInput]').should('not.exist');
    cy.get('[data-cy=UserFormLastNameInput]').should('not.exist');
    cy.get('#role').should('not.be.disabled');
    cy.get(departmentInput).should('not.exist');
    cy.get('[data-cy=UserFormAddBtn]').click();
    cy.get('.fr-input-group--error').should('exist');
    cy.get('#role').select('mte');
    cy.get('[data-cy=UserFormAddBtn]').click();
    userRow(email).should('contain.text', 'MTE');

    userRow(email).find('[data-cy=UserListEditBtn]').click();
    cy.contains('.fr-modal', "Modification d'un utilisateur").should('be.visible');
    cy.get('[data-cy=UserFormEmailInput]').should('be.disabled');
    cy.get('[data-cy=UserFormFirstNameInput]').should('be.disabled');
    cy.get('[data-cy=UserFormLastNameInput]').should('be.disabled');
    cy.get(departmentInput).should('not.exist');
    cy.get('#role').select('departement');
    cy.get('[data-cy=UserFormEditBtn]').click();
    cy.get('.fr-input-group--error').should('exist');
    cy.get(departmentInput).type('test');
    cy.get('[data-cy=UserFormEditBtn]').click();
    cy.get('.fr-input-group--error').should('exist');
    selectDepartment('2B');
    selectDepartment('2A');
    cy.get('[data-cy=UserFormEditBtn]').click();
    userRow(email).should('contain.text', '2B').and('contain.text', '2A');
    showUsers();
    userRow(email).should('contain.text', '2B').and('contain.text', '2A');

    userRow(email).find('[data-cy=UserListEditBtn]').click();
    cy.get('#role').select('mte');
    cy.get(departmentInput).should('not.exist');
    cy.get('[data-cy=UserFormEditBtn]').click();
    userRow(email).should('contain.text', 'MTE').and('not.contain.text', '2B').and('not.contain.text', '2A');
    deleteUser(email);
  });
});
