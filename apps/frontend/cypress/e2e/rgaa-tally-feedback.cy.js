/* global cy, describe, expect, it */

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

const obsoleteIframeAttributes = [
  'align',
  'frameborder',
  'marginheight',
  'marginwidth',
  'scrolling',
];

function installTallyStub(window) {
  window.Tally = {
    openPopup(formId, options) {
      const popup = window.document.createElement('div');
      popup.className = `tally-popup tally-form-${formId}`;
      popup.innerHTML = `
        <iframe
          src="https://tally.so/popup/${formId}"
          title="Tally Forms"
          width="376"
          height="600"
          align="center"
          frameborder="0"
          marginheight="0"
          marginwidth="0"
          scrolling="yes"
        ></iframe>
      `;
      window.document.body.append(popup);
      window.__tallyPopupOptions = options;
      options.onOpen();
    },
  };
}

function visitSituation() {
  cy.intercept('GET', 'https://tally.so/widgets/embed.js*', {
    statusCode: 200,
    headers: { 'content-type': 'application/javascript' },
    body: '',
  });
  cy.intercept('GET', '**/search/?q=*', {
    statusCode: 200,
    body: {
      type: 'FeatureCollection',
      features: [addressFeature],
    },
  });
  cy.intercept('GET', '**/zones/publication', {
    statusCode: 200,
    body: validZonePublication,
  });
  cy.intercept('GET', '**/zones?*', {
    statusCode: 200,
    body: [],
  });
  cy.visit(
    '/situation?adresse=20+Avenue+de+Segur+75007+Paris&profil=particulier',
    { onBeforeLoad: installTallyStub },
  );
  cy.location('pathname').should('equal', '/situation');
}

function assertAccessibleTallyIframe() {
  cy.get('.tally-form-w881YY iframe')
    .should('have.attr', 'title', 'VigiEau - retours utilisateurs')
    .and('have.attr', 'width', '376')
    .and('have.attr', 'height', '600')
    .and('be.focused')
    .then(($iframe) => {
      for (const attribute of obsoleteIframeAttributes) {
        expect($iframe[0].hasAttribute(attribute), attribute).to.equal(false);
      }
    });
}

function closeTallyPopup() {
  cy.window().then((window) => {
    window.document.querySelector('.tally-popup')?.remove();
    window.__tallyPopupOptions.onClose();
  });
}

describe('Formulaire Tally accessible', () => {
  it('ouvre le formulaire depuis le vrai bouton desktop et restitue le focus', () => {
    visitSituation();

    cy.get('[data-cy="OpenFeedbackForm"]:visible')
      .should('have.length', 1)
      .and('contain.text', 'Donner mon avis')
      .focus()
      .click();

    assertAccessibleTallyIframe();
    closeTallyPopup();
    cy.get('[data-cy="OpenFeedbackForm"]:visible').should('be.focused');
  });

  it('place le focus dans Tally depuis le menu à 320 px', () => {
    cy.viewport(320, 800);
    visitSituation();

    cy.get('#button-menu').should('be.visible').click();
    cy.get('#header-navigation')
      .should('have.class', 'fr-modal--opened')
      .find('[data-cy="OpenFeedbackForm"]')
      .should('be.visible')
      .focus()
      .type('{enter}');

    assertAccessibleTallyIframe();
    closeTallyPopup();
    cy.get('#button-menu').should('be.focused');
  });
});
