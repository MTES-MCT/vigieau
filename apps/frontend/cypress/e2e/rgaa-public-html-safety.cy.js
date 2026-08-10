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
