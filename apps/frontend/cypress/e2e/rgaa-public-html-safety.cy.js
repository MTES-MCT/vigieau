/* global cy, describe, expect, it */

describe('Rendu sûr des contenus publics dynamiques', () => {
  it('affiche le libellé API d’un abonnement comme du texte dans la modale', () => {
    const maliciousLabel =
      '<img src=x onerror="document.body.dataset.xss=\'true\'">Zone test';

    cy.intercept('GET', '**/subscriptions', {
      statusCode: 200,
      body: [
        {
          id: 'subscription-test',
          profil: 'particulier',
          libelleLocalisation: maliciousLabel,
          typesEau: ['AEP'],
        },
      ],
    }).as('subscriptions');

    cy.visit('/abonnements?token=test-token');
    cy.wait('@subscriptions');
    cy.contains('.eau-card__title', maliciousLabel).should('be.visible');
    cy.contains('button', 'Me désabonner').click();

    cy.get('.fr-modal--opened').within(() => {
      cy.get('strong')
        .should('have.text', maliciousLabel)
        .and('not.have.descendants', 'img, script');
      cy.get('img, script').should('not.exist');
    });
    cy.get('body').should(($body) => {
      expect($body[0].dataset.xss).to.equal(undefined);
    });
  });

  it('conserve la modale et une seule requête lorsque le désabonnement échoue', () => {
    let unsubscribeRequests = 0;

    cy.intercept('GET', '**/subscriptions', {
      statusCode: 200,
      body: [
        {
          id: 'subscription-test',
          profil: 'particulier',
          libelleLocalisation: 'Paris 7e',
          typesEau: ['AEP'],
        },
      ],
    });
    cy.intercept('DELETE', '**/subscriptions/subscription-test', (request) => {
      unsubscribeRequests += 1;
      request.reply({
        delay: 200,
        statusCode: 500,
        body: { message: 'Erreur de test' },
      });
    }).as('unsubscribe');

    cy.visit('/abonnements?token=test-token');
    cy.contains('button', 'Me désabonner').click();
    cy.contains('button', 'Valider').then(($button) => {
      $button[0].click();
      $button[0].click();
    });

    cy.wait('@unsubscribe');
    cy.get('dialog[open][aria-modal="true"]').should('be.visible');
    cy.get('#unsubscribe-error')
      .should('be.focused')
      .and('contain.text', 'n’a pas pu être effectué');
    cy.contains('button', 'Valider').should('not.be.disabled');
    cy.contains('.eau-card__title', 'Paris 7e').should('exist');
    cy.then(() => {
      expect(unsubscribeRequests).to.equal(1);
    });
  });

  it('annonce un désabonnement réussi et focalise la liste mise à jour', () => {
    cy.intercept('GET', '**/subscriptions', {
      statusCode: 200,
      body: [
        {
          id: 'subscription-paris',
          profil: 'particulier',
          libelleLocalisation: 'Paris 7e',
          typesEau: ['AEP'],
        },
        {
          id: 'subscription-lyon',
          profil: 'particulier',
          libelleLocalisation: 'Lyon 2e',
          typesEau: ['AEP'],
        },
      ],
    });
    cy.intercept('DELETE', '**/subscriptions/subscription-paris', {
      statusCode: 204,
      body: null,
    }).as('unsubscribe');

    cy.visit('/abonnements?token=test-token');
    cy.contains('.eau-card__title', 'Paris 7e')
      .parents('.eau-card')
      .contains('button', 'Me désabonner')
      .click();
    cy.contains('dialog[open] button', 'Valider').click();
    cy.wait('@unsubscribe');

    cy.get('dialog[open]').should('not.exist');
    cy.get('#subscriptions-heading').should('be.focused');
    cy.get('#unsubscribe-status')
      .should('contain.text', 'Désabonnement de l’adresse effectué');
    cy.contains('.eau-card__title', 'Paris 7e').should('not.exist');
    cy.contains('.eau-card__title', 'Lyon 2e').should('be.visible');
  });

  it('rend la page Cookies sans paragraphe vide ni liste imbriquée', () => {
    cy.visit('/cookies');

    cy.contains('h1', "Cookies et mesure d'audience").should('be.visible');
    cy.get('main p').each(($paragraph) => {
      expect($paragraph.text().trim()).not.to.equal('');
      expect($paragraph.find('ul, ol')).to.have.length(0);
    });
    cy.get('main h2').contains("Mesure d'audience")
      .next('p')
      .next('ul')
      .children('li')
      .should('have.length', 3);
  });
});
