/* global cy, describe, expect, it */

const subscription = {
  id: 101,
  profil: 'particulier',
  typesEau: ['AEP'],
  libelleLocalisation: '20 Avenue de Ségur 75007 Paris',
};

const addressFeature = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [0, 48.85] },
  properties: {
    id: 'test-address',
    type: 'housenumber',
    label: 'Adresse sur le méridien',
    citycode: '75107',
  },
};

function fillSubscription(onBeforeLoad) {
  cy.intercept('GET', '**/search/?q=*', {
    statusCode: 200,
    body: { type: 'FeatureCollection', features: [addressFeature] },
  }).as('addressSearch');
  cy.visit('/abonnements/nouveau', onBeforeLoad ? { onBeforeLoad } : {});
  cy.get('#subscription-address').type('adresse sur le méridien');
  cy.wait('@addressSearch');
  cy.get('[role="option"]').first().click();
  cy.get('#subscription-email').type('test@example.test');
  cy.get('label[for="subscription-consent"]').click();
}

function confirmUnsubscribe() {
  cy.get('dialog[open]').contains('button', 'Valider').click();
}

describe('Gestion des abonnements', () => {
  it('propose un lien sans jeton, valide l’e-mail et évite les doubles envois', () => {
    cy.intercept('GET', '**/subscriptions', { statusCode: 401 }).as('subscriptions');
    cy.intercept('POST', '**/subscriptions/management-link', {
      statusCode: 202,
      body: { message: 'Demande prise en compte.' },
      delay: 400,
    }).as('managementLink');
    cy.visit('/abonnements');
    cy.location('pathname').should('equal', '/abonnements');
    cy.contains('h2', 'Recevoir un lien de gestion').should('be.visible');
    cy.get('#management-link-email').type('invalide{enter}');
    cy.get('#management-link-error').should('contain.text', 'nom@exemple.fr');
    cy.get('#management-link-email').should('be.focused').and('have.attr', 'aria-invalid', 'true');
    cy.get('@managementLink.all').should('have.length', 0);
    cy.get('#management-link-email').clear().type('test@example.test{enter}');
    cy.get('form button[type="submit"]').should('be.disabled');
    cy.get('form').trigger('submit');
    cy.wait('@managementLink').its('request.body').should('deep.equal', { email: 'test@example.test' });
    cy.get('#management-link-status').should('be.visible').and('contain.text', 'Si cette adresse e-mail possède des abonnements').and('be.focused');
    cy.get('@managementLink.all').should('have.length', 1);
    cy.get('@subscriptions.all').should('have.length', 0);
  });

  it('explique le lien expiré et permet de demander un nouveau lien', () => {
    cy.intercept('GET', '**/subscriptions', { statusCode: 401 }).as('subscriptions');
    cy.intercept('POST', '**/subscriptions/management-link', { statusCode: 202 }).as('managementLink');
    cy.visit('/abonnements?token=expired');
    cy.wait('@subscriptions').its('request.headers.authorization').should('equal', 'Bearer expired');
    cy.contains('Ce lien de gestion est expiré ou invalide').should('be.visible');
    cy.get('#management-link-email').type('test@example.test{enter}');
    cy.wait('@managementLink');
    cy.get('#management-link-status').should('contain.text', 'Si cette adresse e-mail possède des abonnements');
    cy.location('pathname').should('equal', '/abonnements');
  });

  for (const [statusCode, message] of [
    [429, 'Trop de demandes'],
    [503, 'L’envoi du lien est momentanément indisponible'],
  ]) {
    it(`affiche l’erreur ${statusCode} de récupération sans réessai automatique`, () => {
      cy.intercept('POST', '**/subscriptions/management-link', { statusCode }).as('managementLink');
      cy.visit('/abonnements');
      cy.get('#management-link-email').type('test@example.test{enter}');
      cy.wait('@managementLink');
      cy.get('#management-link-error').should('contain.text', message).and('be.focused');
      cy.get('#management-link-email').should('have.value', 'test@example.test');
      cy.get('@managementLink.all').should('have.length', 1);
      cy.get('#management-link-status').should('be.empty');
    });
  }

  it('distingue une panne de chargement d’un lien expiré et permet de réessayer', () => {
    let attempts = 0;
    cy.intercept('GET', '**/subscriptions', request => {
      request.reply(++attempts === 1 ? { statusCode: 500 } : { statusCode: 200, body: [subscription] });
    }).as('subscriptions');
    cy.visit('/abonnements?token=valid');
    cy.wait('@subscriptions');
    cy.contains('Vos abonnements ne peuvent pas être chargés').should('be.visible');
    cy.get('#management-link-email').should('not.exist');
    cy.contains('button', 'Réessayer').click();
    cy.wait('@subscriptions');
    cy.contains(subscription.libelleLocalisation).should('be.visible');
    cy.get('@subscriptions.all').should('have.length', 2);
  });

  it('reste sur la page avec un état vide quand aucun abonnement ne reste', () => {
    cy.intercept('GET', '**/subscriptions', { statusCode: 200, body: [] });
    cy.visit('/abonnements?token=valid');
    cy.contains('Vous n’avez plus d’abonnement').should('be.visible');
    cy.contains('Ajouter une nouvelle adresse').should('have.attr', 'href', '/abonnements/nouveau');
    cy.location('pathname').should('equal', '/abonnements');
  });

  it('désabonne toutes les adresses par la route racine et conserve une confirmation visible', () => {
    cy.intercept('GET', '**/subscriptions', {
      statusCode: 200,
      body: [subscription, { ...subscription, id: 102, libelleLocalisation: 'Autre adresse' }],
    });
    cy.intercept('DELETE', '**/subscriptions', { statusCode: 204, delay: 300 }).as('unsubscribe');
    cy.visit('/abonnements?token=valid');
    cy.contains('button', 'Me désabonner de toutes les adresses').click();
    confirmUnsubscribe();
    cy.get('dialog[open]').contains('button', 'Valider').should('be.disabled');
    cy.wait('@unsubscribe').its('request.headers.authorization').should('equal', 'Bearer valid');
    cy.get('#unsubscribe-status').should('contain.text', 'Désabonnement de toutes les adresses effectué.').and('be.visible').and('be.focused');
    cy.contains('Vous n’avez plus d’abonnement').should('be.visible');
    cy.get('@unsubscribe.all').should('have.length', 1);
    cy.location('pathname').should('equal', '/abonnements');
  });

  it('conserve la confirmation après le dernier désabonnement individuel', () => {
    cy.intercept('GET', '**/subscriptions', { statusCode: 200, body: [subscription] });
    cy.intercept('DELETE', '**/subscriptions/101', { statusCode: 204 }).as('unsubscribe');
    cy.visit('/abonnements?token=valid');
    cy.contains('button', 'Me désabonner').click();
    confirmUnsubscribe();
    cy.wait('@unsubscribe');
    cy.get('#unsubscribe-status').should('contain.text', 'Désabonnement de l’adresse effectué.').and('be.visible').and('be.focused');
    cy.contains('Vous n’avez plus d’abonnement').should('be.visible');
    cy.location('pathname').should('equal', '/abonnements');
  });

  it('propose un nouveau lien si le jeton expire au moment du désabonnement', () => {
    cy.intercept('GET', '**/subscriptions', { statusCode: 200, body: [subscription] });
    cy.intercept('DELETE', '**/subscriptions/101', { statusCode: 401 }).as('unsubscribe');
    cy.visit('/abonnements?token=valid');
    cy.contains('button', 'Me désabonner').click();
    confirmUnsubscribe();
    cy.wait('@unsubscribe');
    cy.contains('Ce lien de gestion est expiré ou invalide').should('be.visible');
    cy.get('dialog[open]').should('not.exist');
    cy.get('#management-link-email').should('be.focused');
  });

  it('garde la liste et la modale après une erreur de désabonnement', () => {
    cy.intercept('GET', '**/subscriptions', { statusCode: 200, body: [subscription] });
    cy.intercept('DELETE', '**/subscriptions/101', { statusCode: 500 }).as('unsubscribe');
    cy.visit('/abonnements?token=valid');
    cy.contains('button', 'Me désabonner').click();
    confirmUnsubscribe();
    cy.wait('@unsubscribe');
    cy.get('#unsubscribe-error').should('contain.text', 'n’a pas pu être effectué').and('be.focused');
    cy.get('dialog[open]').should('be.visible');
    cy.get('@unsubscribe.all').should('have.length', 1);
  });
});

describe('Confirmation d’abonnement', () => {
  it('explique la limite de demandes sans changer d’adresse ni réessayer', () => {
    cy.intercept('POST', '**/subscriptions', { statusCode: 429 }).as('subscribe');
    fillSubscription();
    cy.get('[data-cy="SubscriptionSubmit"]').click();
    cy.wait('@subscribe');
    cy.get('dialog[open]').should('contain.text', 'Trop de demandes ont été effectuées')
      .and('contain.text', 'Patientez 15 minutes')
      .and('not.contain.text', 'une autre adresse');
    cy.get('dialog[open]').contains('button', 'Fermer').click();
    cy.get('#subscription-email').should('have.value', 'test@example.test');
    cy.get('#subscription-address').should('have.value', addressFeature.properties.label);
    cy.get('@subscribe.all').should('have.length', 1);
  });

  it('préserve les coordonnées à zéro et réessaie l’envoi de confirmation avec le même formulaire', () => {
    let attempts = 0;
    cy.intercept('POST', '**/subscriptions', request => {
      expect(request.body.lon).to.equal(0);
      expect(request.body.lat).to.equal(48.85);
      request.reply(++attempts === 1
        ? { statusCode: 503, body: { code: 'SUBSCRIPTION_CONFIRMATION_UNAVAILABLE' } }
        : { statusCode: 201, body: { id: 101 } });
    }).as('subscribe');
    fillSubscription();
    cy.get('[data-cy="SubscriptionSubmit"]').click();
    cy.wait('@subscribe');
    cy.get('dialog[open]').should('contain.text', 'Abonnement enregistré, e-mail non envoyé')
      .and('contain.text', 'Votre abonnement est enregistré');
    cy.get('@subscribe.all').should('have.length', 1);
    cy.get('dialog[open]').contains('button', 'Fermer').click();
    cy.get('#subscription-email').should('have.value', 'test@example.test');
    cy.get('#subscription-address').should('have.value', addressFeature.properties.label);
    cy.get('[data-cy="SubscriptionSubmit"]').should('be.focused').click();
    cy.wait('@subscribe');
    cy.get('dialog[open]').should('contain.text', 'Abonnement confirmé');
    cy.get('@subscribe.all').should('have.length', 2);
  });

  it('explique une panne serveur sans changer d’adresse ni réessayer', () => {
    cy.intercept('POST', '**/subscriptions', { statusCode: 500 }).as('subscribe');
    fillSubscription();
    cy.get('[data-cy="SubscriptionSubmit"]').click();
    cy.wait('@subscribe');
    cy.get('dialog[open]').should('contain.text', 'Le service est temporairement indisponible')
      .and('not.contain.text', 'une autre adresse');
    cy.get('@subscribe.all').should('have.length', 1);
  });

  it('explique une panne réseau sans changer d’adresse ni réessayer', () => {
    let attempts = 0;
    fillSubscription((win) => {
      const originalFetch = win.fetch.bind(win);
      cy.stub(win, 'fetch').callsFake((url, options) => {
        if (String(url).endsWith('/subscriptions') && options?.method === 'POST') {
          attempts += 1;
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return originalFetch(url, options);
      });
    });
    cy.get('[data-cy="SubscriptionSubmit"]').click();
    cy.get('dialog[open]').should('contain.text', 'Le service est temporairement indisponible')
      .and('not.contain.text', 'une autre adresse');
    cy.then(() => expect(attempts).to.equal(1));
  });
});
