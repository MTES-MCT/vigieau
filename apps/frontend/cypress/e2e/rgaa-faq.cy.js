/* global beforeEach, cy, describe, expect, it */

function stubHomeApis() {
  cy.intercept('GET', '**/data', {
    statusCode: 200,
    body: {
      bassinsVersants: [],
      regions: [],
      departements: [],
    },
  });
  cy.intercept('GET', '**/zones/publication', {
    statusCode: 503,
    body: { message: 'Publication indisponible pendant le test' },
  });
  cy.intercept('HEAD', '**/*.pmtiles*', {
    statusCode: 503,
    body: '',
  });
}

describe('FAQ publique accessible', () => {
  beforeEach(() => {
    stubHomeApis();
    cy.visit('/');
    cy.get('.faq').should('be.visible');
  });

  it('rend un groupe div unique avec la hiérarchie h3/h4', () => {
    cy.get('.faq .fr-accordions-group')
      .should('have.length', 1)
      .then(($group) => {
        expect($group[0].tagName).to.equal('DIV');
        expect([...$group[0].children].every((child) =>
          child.matches('h3, section.fr-accordion'))).to.equal(true);
      });

    cy.get('.faq .fr-accordions-group')
      .children('h3')
      .should('have.length', 4)
      .each(($heading) => {
        expect($heading[0].tagName).to.equal('H3');
      });
    cy.get('.faq .fr-accordions-group')
      .children('.fr-accordion')
      .should('have.length', 17)
      .children('.fr-accordion__title')
      .should('have.length', 17)
      .each(($title) => {
        expect($title[0].tagName).to.equal('H4');
      });
    cy.get('.faq .fr-accordion__btn')
      .should('have.length', 17)
      .then(($buttons) => {
        const panelIds = [...$buttons].map((button) =>
          button.getAttribute('aria-controls'));

        expect(new Set(panelIds).size).to.equal(panelIds.length);
        for (const panelId of panelIds) {
          expect(panelId).to.match(/^\d{2}$/);
          expect(
            $buttons[0].ownerDocument.getElementById(panelId),
          ).not.to.equal(null);
        }
      });
  });

  it('rend les causes et les solutions en listes et masque les flèches', () => {
    cy.contains(
      '.fr-accordion__btn',
      'Quelles sont les causes des sécheresses ?',
    ).click();
    cy.get('[id="01"]').should('be.visible').within(() => {
      cy.get('p').should('have.length', 3);
      cy.get('ul > li').should('have.length', 3);
      cy.root().should('not.contain.text', 'nbps');
    });

    cy.contains(
      '.fr-accordion__btn',
      'Comment le Gouvernement se mobilise-t-il',
    ).click();
    cy.get('[id="01"]').should('not.be.visible');
    cy.get('[id="10"]').should('be.visible').within(() => {
      cy.get('ul > li').should('have.length', 3);
      cy.get('span[aria-hidden="true"]')
        .should('have.length', 3)
        .each(($arrow) => {
          expect($arrow.text().trim()).to.equal('→');
        });
    });

    cy.contains(
      '.fr-accordion__btn',
      'Comment serai-je approvisionné en eau potable',
    ).click();
    cy.get('[id="10"]').should('not.be.visible');
    cy.get('[id="28"]').should('be.visible').within(() => {
      cy.get('p').should('have.length', 3);
      cy.get('ul > li')
        .should('have.length', 3)
        .then(($solutions) => {
          expect($solutions.eq(0).text()).to.contain('eau embouteillée');
          expect($solutions.eq(1).text()).to.contain('unités mobiles');
          expect($solutions.eq(2).text()).to.contain('camions citernes');
        });
      cy.root().should('not.contain.text', '•');
      cy.get('a[href="https://www.legifrance.gouv.fr/circulaire/id/42547"]')
        .should('have.attr', 'target', '_blank')
        .and('have.attr', 'rel')
        .then((rel) => {
          const tokens = new Set(rel.split(/\s+/));

          expect(tokens.has('noopener')).to.equal(true);
          expect(tokens.has('noreferrer')).to.equal(true);
        });
      cy.get('a[href="https://www.legifrance.gouv.fr/circulaire/id/42547"]')
        .should('contain.text', 'instruction ORSEC Eau potable')
        .and('contain.text', 'nouvelle fenêtre')
        .find('[data-vigieau-new-window-suffix]')
        .should('have.length', 1);
    });

    cy.get('.faq a[href*=".pdf" i]').should('not.exist');
    cy.get(
      '.faq a[href="https://www.ecologie.gouv.fr/politiques-publiques/origine-gestion-secheresse"]',
    )
      .should('have.length', 1)
      .and('contain.text', 'nouvelle fenêtre');
  });
});
