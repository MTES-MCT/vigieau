/* global cy, Cypress, describe, expect, it */

const addressFeature = {
  type: 'Feature',
  geometry: { coordinates: [2.308, 48.85] },
  properties: {
    id: '75107_8240_00020',
    type: 'housenumber',
    label: '20 Avenue de Ségur 75007 Paris',
    postcode: '75007',
    citycode: '75107',
    context: '75, Paris, Île-de-France',
  },
};

const validZonePublication = {
  id: '29959a00-0000-4000-8000-000000000000',
  revision: '42',
  pmtilesUrl: 'https://example.test/zones/42.pmtiles',
  pmtilesChecksum: 'a'.repeat(64),
};

const subscriptionAddress = () => cy.get(
  '#subscription-address[role="combobox"]',
);
const subscriptionSubmit = () => cy.get(
  '[data-cy="SubscriptionSubmit"]',
);
const mainAddress = () => cy.get(
  '#main-search-address[role="combobox"]',
);
const mainSubmit = () => cy.get(
  '[data-cy="MainRestrictionSearchSubmit"]',
);

function stubAddressSearch() {
  cy.intercept('GET', '**/search/?q=*', {
    statusCode: 200,
    body: {
      type: 'FeatureCollection',
      features: [addressFeature],
    },
  }).as('addressSearch');
}

function selectAddress(input) {
  input().focus().type('20 avenue de Ségur');
  cy.wait('@addressSearch');
  cy.get('[role="listbox"] [role="option"]')
    .first()
    .click();
  input().should('have.value', addressFeature.properties.label);
}

function describedElements(control) {
  const ids = (control.getAttribute('aria-describedby') || '')
    .split(/\s+/)
    .filter(Boolean);

  return ids.map(id => control.ownerDocument.getElementById(id));
}

function assertLinkedDescription(selector, expectedId, expectedText) {
  cy.get(selector).should(($control) => {
    const control = $control[0];
    const descriptions = describedElements(control);
    const description = control.ownerDocument.getElementById(expectedId);

    expect(description, `#${expectedId}`).not.to.equal(null);
    expect(descriptions, `${selector} aria-describedby`).to.include(description);
    expect(description.textContent).to.match(expectedText);
  });
}

function assertInvalidField(selector, errorId, errorText) {
  cy.get(selector).should('have.attr', 'aria-invalid', 'true');
  assertLinkedDescription(selector, errorId, errorText);
  cy.get(`#${errorId}`).should('be.visible');
}

function assertCorrectedField(selector, errorId) {
  cy.get(selector).should('not.have.attr', 'aria-invalid', 'true');
  cy.get(selector).should(($control) => {
    const describedIds = ($control.attr('aria-describedby') || '')
      .split(/\s+/)
      .filter(Boolean);

    expect(describedIds).not.to.include(errorId);
  });
  cy.get(`#${errorId}`).should('not.exist');
}

function assertNamedModal(titleId, expectedTitle) {
  cy.get(`[aria-labelledby="${titleId}"]`)
    .should('be.visible')
    .and('have.attr', 'aria-modal', 'true')
    .should(($modal) => {
      expect($modal.attr('role')).to.match(/^(dialog|alertdialog)$/);
    })
    .as('activeModal');
  cy.get(`#${titleId}`).should('contain.text', expectedTitle);
  cy.get('@activeModal').should(($modal) => {
    expect($modal[0].contains($modal[0].ownerDocument.activeElement))
      .to.equal(true);
  });
  cy.focused().should(($focused) => {
    const accessibleText = [
      $focused.text(),
      $focused.attr('aria-label'),
      $focused.attr('title'),
    ].filter(Boolean).join(' ');

    expect(accessibleText).to.match(/fermer/i);
  });
}

function fillValidSubscription() {
  selectAddress(subscriptionAddress);
  cy.get('#subscription-email').clear().type('test@exemple.com');
  cy.get('label[for="subscription-consent"]').click();
  cy.get('#subscription-consent').should('be.checked');
}

describe('Formulaire public d’abonnement accessible', () => {
  it('expose des groupes nommés, les champs obligatoires et une aide e-mail séparée', () => {
    cy.visit('/abonnements/nouveau');

    cy.get('[data-cy="SubscriptionForm"]')
      .should('have.prop', 'tagName', 'FORM')
      .and('have.attr', 'novalidate');

    cy.get('#subscription-profile-group')
      .should('have.prop', 'tagName', 'FIELDSET')
      .within(() => {
        cy.get('legend')
          .should('contain.text', 'Agissez-vous en tant que')
          .and('contain.text', 'obligatoire');
        cy.get('button[type="button"]')
          .should('have.length', 4)
          .then(($buttons) => {
            const names = [...$buttons].map(button => button.textContent.trim());
            expect(names).to.deep.equal([
              'Particulier',
              'Agriculteur',
              'Entreprise',
              'Collectivité',
            ]);
          });
      });
    cy.get('#subscription-profile-group-particulier')
      .should('have.attr', 'aria-pressed', 'true');

    cy.get('#subscription-water-types-group')
      .should('have.prop', 'tagName', 'FIELDSET')
      .within(() => {
        cy.get('legend')
          .should('contain.text', 'changements de restrictions')
          .and('contain.text', 'obligatoire');
        cy.get('input[type="checkbox"]')
          .should('have.length', 3)
          .each(($checkbox) => {
            cy.get(`label[for="${$checkbox.attr('id')}"]`).should('not.be.empty');
          });
      });

    subscriptionAddress().should('have.attr', 'required');
    cy.get('#subscription-email')
      .should('have.attr', 'type', 'email')
      .and('have.attr', 'autocomplete', 'email')
      .and('have.attr', 'required');
    cy.get('label[for="subscription-email"]')
      .should('contain.text', 'e-mail')
      .and('contain.text', 'obligatoire')
      .should(($label) => {
        const hint = $label[0].ownerDocument.getElementById(
          'subscription-email-hint',
        );
        expect(hint).not.to.equal(null);
        expect($label[0].contains(hint)).to.equal(false);
      });
    assertLinkedDescription(
      '#subscription-email',
      'subscription-email-hint',
      /nom@exemple\.fr/i,
    );
    cy.get('#subscription-email-hint').should('be.visible');

    cy.get('#subscription-consent')
      .should('have.attr', 'type', 'checkbox')
      .and('have.attr', 'required');
    cy.get('label[for="subscription-consent"]')
      .should('contain.text', 'J’accepte')
      .and('contain.text', 'obligatoire');
    subscriptionSubmit()
      .should('have.prop', 'tagName', 'BUTTON')
      .and('have.attr', 'type', 'submit')
      .and('not.be.disabled');
  });

  it('soumet au clavier, focalise la première erreur et retire les erreurs corrigées', () => {
    stubAddressSearch();
    cy.intercept('POST', '**/subscriptions').as('subscriptionRequest');
    cy.visit('/abonnements/nouveau');

    cy.get('label[for="subscription-water-aep"]').click();
    cy.get('label[for="subscription-water-sup"]').click();
    cy.get('label[for="subscription-water-sou"]').click();
    cy.get('#subscription-water-types-group input').should('not.be.checked');
    cy.get('#subscription-email').type('adresse-invalide{enter}');

    cy.get('#subscription-water-aep').should('have.focus');
    assertInvalidField(
      '#subscription-water-types-group',
      'subscription-water-types-error',
      /type d’eau.*obligatoire/i,
    );
    assertInvalidField(
      '#subscription-address',
      'subscription-address-error',
      /adresse.*obligatoire/i,
    );
    assertInvalidField(
      '#subscription-email',
      'subscription-email-error',
      /adresse e-mail.*format/i,
    );
    assertInvalidField(
      '#subscription-consent',
      'subscription-consent-error',
      /acceptation.*obligatoire/i,
    );
    cy.get('@subscriptionRequest.all').should('have.length', 0);

    cy.get('label[for="subscription-water-aep"]').click();
    cy.get('#subscription-water-aep').should('be.checked');
    assertCorrectedField(
      '#subscription-water-types-group',
      'subscription-water-types-error',
    );
    selectAddress(subscriptionAddress);
    assertCorrectedField(
      '#subscription-address',
      'subscription-address-error',
    );
    cy.get('#subscription-email').clear().type('test@exemple.com');
    assertCorrectedField('#subscription-email', 'subscription-email-error');
    assertLinkedDescription(
      '#subscription-email',
      'subscription-email-hint',
      /nom@exemple\.fr/i,
    );
    cy.get('label[for="subscription-consent"]').click();
    cy.get('#subscription-consent').should('be.checked');
    assertCorrectedField(
      '#subscription-consent',
      'subscription-consent-error',
    );
  });

  it('n’émet qu’un POST sur Entrée et ouvre une modale de succès nommée', () => {
    stubAddressSearch();
    cy.intercept('POST', '**/subscriptions', {
      statusCode: 201,
      body: { id: 42 },
    }).as('subscriptionRequest');
    cy.visit('/abonnements/nouveau');
    fillValidSubscription();

    cy.get('#subscription-email').focus().type('{enter}');

    cy.wait('@subscriptionRequest').then(({ request }) => {
      expect(request.body.email).to.equal('test@exemple.com');
      expect(request.body.idAdresse).to.equal(addressFeature.properties.id);
      expect(request.body.typesEau).to.deep.equal(['AEP', 'SUP', 'SOU']);
      expect(request.body.confirmSubscription).to.equal(true);
    });
    cy.get('@subscriptionRequest.all').should('have.length', 1);
    assertNamedModal(
      'subscription-success-title',
      'Abonnement confirmé',
    );
  });

  it('nomme la modale d’erreur et restitue le focus au bouton de soumission', () => {
    stubAddressSearch();
    cy.intercept('POST', '**/subscriptions', {
      statusCode: 500,
      body: { message: 'Erreur simulée' },
    }).as('subscriptionRequest');
    cy.visit('/abonnements/nouveau');
    fillValidSubscription();

    subscriptionSubmit().click();
    cy.wait('@subscriptionRequest');
    assertNamedModal(
      'subscription-error-title',
      'L’abonnement n’a pas pu être enregistré',
    );

    cy.press(Cypress.Keyboard.Keys.ESC);
    cy.get('dialog[aria-labelledby="subscription-error-title"]')
      .should('not.have.attr', 'open');
    cy.get('dialog[aria-labelledby="subscription-error-title"]')
      .should('not.be.visible');
    subscriptionSubmit().should('have.focus');
  });
});

describe('Formulaire public de recherche des restrictions', () => {
  it('soumet sur Entrée, relie l’erreur d’adresse et focalise le champ', () => {
    stubAddressSearch();
    cy.visit('/');

    cy.get('[data-cy="MainRestrictionSearchForm"]')
      .should('have.prop', 'tagName', 'FORM')
      .and('have.attr', 'novalidate');
    cy.get('#main-search-profile')
      .should('have.attr', 'required');
    cy.get('label[for="main-search-profile"]')
      .should('contain.text', 'profil de consommateur')
      .and('contain.text', 'obligatoire');
    cy.get('#main-search-water-type')
      .should('have.attr', 'required');
    cy.get('label[for="main-search-water-type"]')
      .should('contain.text', 'type d’eau')
      .and('contain.text', 'obligatoire');
    mainAddress().should('have.attr', 'required');
    mainSubmit()
      .should('have.attr', 'type', 'submit')
      .and('not.be.disabled');

    mainAddress().focus().type('{enter}');

    mainAddress().should('have.focus');
    assertInvalidField(
      '#main-search-address',
      'main-search-address-error',
      /adresse.*géolocalisation.*obligatoire/i,
    );

    selectAddress(mainAddress);
    assertCorrectedField(
      '#main-search-address',
      'main-search-address-error',
    );
  });

  it('déclenche la recherche valide une seule fois avec Entrée', () => {
    stubAddressSearch();
    cy.intercept('GET', '**/zones/publication', {
      statusCode: 200,
      body: validZonePublication,
    });
    cy.intercept('GET', '**/zones?*', {
      statusCode: 200,
      body: [],
    }).as('zoneSearch');
    cy.visit('/');
    selectAddress(mainAddress);

    mainAddress().type('{enter}');

    cy.wait('@zoneSearch').then(({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get('lon')).to.equal('2.308');
      expect(url.searchParams.get('lat')).to.equal('48.85');
      expect(url.searchParams.get('commune')).to.equal('75107');
    });
    cy.get('@zoneSearch.all').should('have.length', 1);
  });
});
