/* global cy, describe, expect, it */

function assertUniqueIds() {
  cy.document().then((document) => {
    const ids = [...document.querySelectorAll('[id]')]
      .map(element => element.id)
      .filter(Boolean);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);

    expect([...new Set(duplicates)], 'IDs dupliqués').to.deep.equal([]);
  });
}

describe('Gabarits publics des pages e-mail', () => {
  for (const path of ['/emails', '/emails/smgc']) {
    it(`${path} expose les landmarks et les liens d’évitement`, () => {
      cy.visit(path);
      cy.get('main#main-content[role="main"][tabindex="-1"]')
        .should('have.length', 1);
      cy.get('h1').should('have.length', 1).and('contain.text', 'Merci');
      cy.contains('a', 'Contenu').focus().click();
      cy.focused().should('have.attr', 'id', 'main-content');
      cy.contains('a', 'Pied de page').should('have.attr', 'href', '#footer');
      assertUniqueIds();
    });
  }
});
