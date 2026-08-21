/* global cy, describe, expect, it */

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

describe('Navigation accessible du site public', () => {
  it("expose des liens d'évitement utilisables et des régions uniques", () => {
    cy.visit('/mentions-legales');

    cy.get('main').should('have.length', 1);
    cy.get('#main-content')
      .should('have.length', 1)
      .and('match', 'main')
      .and('have.attr', 'tabindex', '-1');

    cy.get('footer').should('have.length', 1);
    cy.get('#footer').should('have.length', 1).and('match', 'footer');

    cy.get('.fr-skiplinks a[href="#main-content"]')
      .should('have.length', 1)
      .and('contain.text', 'Contenu')
      .focus()
      .should('be.visible')
      .click();
    cy.get('main#main-content').should('be.focused');

    cy.get('.fr-skiplinks a[href="#footer"]')
      .should('have.length', 1)
      .and('contain.text', 'Pied de page')
      .focus()
      .should('be.visible')
      .click();
    cy.get('footer#footer').should('be.focused');

    cy.get('#footer .fr-footer__content-desc').should(($description) => {
      expect($description.text().trim()).not.to.equal('');
    });
  });

  it('maintient le focus dans le menu mobile et le rend au déclencheur', () => {
    cy.viewport(320, 800);
    cy.visit('/mentions-legales');

    cy.get('#button-menu')
      .should('be.visible')
      .and('have.attr', 'aria-controls', 'header-navigation')
      .and('have.attr', 'aria-haspopup', 'dialog')
      .and('have.attr', 'aria-label', 'Menu')
      .within(() => {
        cy.get('.fr-sr-only').should('have.text', 'Menu');
      })
      .focus()
      .then(($button) => {
        // Cypress réapplique le focus après .click()/.type('{enter}').
        // L'activation DOM native laisse l'application gérer le focus final.
        $button[0].click();
      });

    cy.get('#header-navigation')
      .should('be.visible')
      .and('have.attr', 'role', 'dialog')
      .and('have.attr', 'aria-modal', 'true')
      .and('have.attr', 'aria-label', 'Menu');
    cy.get('#header-navigation nav nav').should('not.exist');
    cy.get('#header-navigation').then(($dialog) => {
      const focusableElements = $dialog.find(focusableSelector).filter(
        (_index, element) =>
          !element.hidden && element.getAttribute('aria-hidden') !== 'true',
      );
      const firstElement = focusableElements.first();
      const lastElement = focusableElements.last();

      expect(focusableElements.length).to.be.greaterThan(1);
      cy.wrap(firstElement).should('be.visible').and('be.focused');
      cy.wrap(lastElement).should('be.visible').focus();
      cy.wrap(lastElement).trigger('keydown', {
        key: 'Tab',
        eventConstructor: 'KeyboardEvent',
      });
      cy.focused().should(($focused) => {
        expect($focused[0]).to.equal(firstElement[0]);
      });

      cy.wrap(firstElement).trigger('keydown', {
        key: 'Tab',
        shiftKey: true,
        eventConstructor: 'KeyboardEvent',
      });
      cy.focused().should(($focused) => {
        expect($focused[0]).to.equal(lastElement[0]);
      });
    });

    cy.get('body').type('{esc}');
    cy.get('#header-navigation').should('not.have.class', 'fr-modal--opened');
    cy.get('#button-menu').should('be.focused');
  });

  it('annonce une navigation SPA et place le focus sur le nouveau titre', () => {
    cy.visit('/mentions-legales');
    cy.title().should('equal', 'Mentions légales - VigiEau');
    cy.window().then((window) => {
      window.__rgaaNavigationSentinel = true;
    });

    cy.contains('a', "Déclaration d'accessibilité").click();

    cy.location('pathname').should('equal', '/accessibilite');
    cy.window()
      .its('__rgaaNavigationSentinel')
      .should('equal', true);
    cy.title().should('equal', 'Accessibilité - VigiEau');
    cy.get('#main-content h1')
      .should('have.text', 'Déclaration d’accessibilité')
      .and('have.attr', 'tabindex', '-1')
      .and('be.focused');
    cy.get('[role="status"][aria-live="polite"]')
      .should('have.attr', 'aria-atomic', 'true')
      .and('have.text', 'Page Déclaration d’accessibilité chargée');
  });

  it('conserve un contenu principal unique et focalise le titre de la carte', () => {
    cy.intercept('GET', '**/departements?*', {
      statusCode: 200,
      body: [],
    });
    cy.visit('/mentions-legales');

    cy.get('main#main-content').then(($main) =>
      $main[0].__vueParentComponent.appContext.config.globalProperties.$router.push(
        '/carte',
      ),
    );

    cy.location('pathname').should('equal', '/carte');
    cy.title().should('equal', 'Carte des restrictions - VigiEau');
    cy.get('main#main-content').should('have.length', 1);
    cy.get('main#main-content h1:visible')
      .should('have.length', 1)
      .and('have.attr', 'tabindex', '-1')
      .and('be.focused')
      .invoke('text')
      .then((text) => expect(text.trim()).to.equal('Carte des restrictions'));
    cy.get('[role="status"][aria-live="polite"]')
      .should('have.attr', 'aria-atomic', 'true')
      .and(
        'have.text',
        'Page Carte des restrictions chargée',
      );
  });

  it("place le focus sur Accueil après l'ouverture du fil d'Ariane mobile", () => {
    cy.viewport(320, 800);
    cy.visit('/accessibilite');

    cy.get('.fr-breadcrumb__button')
      .should('be.visible')
      .focus()
      .type('{enter}');

    cy.get('.fr-breadcrumb__button').should('not.exist');
    cy.get('.fr-breadcrumb__link')
      .first()
      .should('have.text', 'Accueil')
      .and('have.attr', 'href', '/')
      .and('be.focused');
  });
});
