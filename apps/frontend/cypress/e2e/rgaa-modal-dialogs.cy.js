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

const restrictionUsage = (id, name) => ({
  id,
  thematique: 'Arroser',
  nom: name,
  description: `Description accessible de ${name}`,
  erreur: '',
  concerneParticulier: true,
  concerneEntreprise: true,
  concerneCollectivite: true,
  concerneExploitation: true,
});

const restrictionZone = {
  id: 'zone-restrictions',
  type: 'AEP',
  profil: 'particulier',
  nom: 'Zone des restrictions',
  departement: '75',
  niveauGravite: 'crise',
  arrete: {
    idArrete: 'arrete-restrictions',
    dateDebutValidite: '2026-08-01',
    dateFinValidite: '2026-08-31',
    cheminFichier: '',
    cheminFichierArreteCadre: '',
  },
  arreteMunicipalCheminFichier: '',
  usages: [
    restrictionUsage(101, 'Arrosage des jardins'),
    restrictionUsage(102, 'Arrosage des potagers'),
    restrictionUsage(103, 'Arrosage des espaces verts'),
  ],
  usagesHash: 'zone-restrictions',
};

const multiZones = [
  {
    ...restrictionZone,
    id: 'zone-amont',
    type: 'SUP',
    nom: 'Bassin amont',
    niveauGravite: 'alerte',
    usages: [],
    usagesHash: 'zone-amont',
  },
  {
    ...restrictionZone,
    id: 'zone-aval',
    type: 'SUP',
    nom: 'Bassin aval',
    niveauGravite: 'vigilance',
    usages: [],
    usagesHash: 'zone-aval',
  },
];

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function stubSituation(zones) {
  cy.intercept('GET', '**/search/?q=*', {
    statusCode: 200,
    body: {
      type: 'FeatureCollection',
      features: [addressFeature],
    },
  }).as('addressSearch');
  cy.intercept('GET', '**/zones/publication', {
    statusCode: 200,
    body: validZonePublication,
  }).as('zonePublication');
  cy.intercept('GET', '**/zones?*', {
    statusCode: 200,
    body: zones,
  }).as('zoneSearch');
}

function visitSituation(zones, typeEau = 'AEP') {
  stubSituation(zones);
  cy.visit(
    `/situation?adresse=20+Avenue+de+Segur+75007+Paris&profil=particulier&typeEau=${typeEau}`,
  );
  cy.location('pathname').should('equal', '/situation');
  cy.get('.situation-status').should(
    zones.length > 1 ? 'exist' : 'be.visible',
  );
  if (zones.length === 1) {
    cy.get('main h1').should('be.focused');
  }
}

function visibleRestrictionTrigger(title) {
  return cy.get('.eau-card h3')
    .filter(':visible')
    .filter((_index, heading) => heading.textContent.includes(title))
    .first()
    .closest('.eau-card')
    .find('button')
    .filter(':visible')
    .first();
}

function assertNativeModal(expectedTitle) {
  cy.get('dialog[data-accessible-modal][open]')
    .should('have.length', 1)
    .and('be.visible')
    .and('have.attr', 'aria-modal', 'true')
    .should(($dialog) => {
      const dialog = $dialog[0];
      const titleId = dialog.getAttribute('aria-labelledby');
      const title = titleId
        ? dialog.ownerDocument.getElementById(titleId)
        : null;

      expect(dialog.matches(':modal'), 'native top-layer modal').to.equal(true);
      expect(dialog.getAttribute('role')).to.match(/^(dialog|alertdialog)$/);
      expect(titleId, 'aria-labelledby').to.match(/\S/);
      expect(title, 'referenced modal title').not.to.equal(null);
      expect(title.textContent.trim()).to.include(expectedTitle);
      const activeElement = dialog.ownerDocument.activeElement;
      const activeDescription = activeElement?.outerHTML || activeElement?.nodeName;

      expect(
        dialog.contains(activeElement),
        `focus in modal; active element: ${activeDescription}`,
      ).to.equal(true);
    })
    .as('activeModal');
}

function visibleFocusableElements(dialog) {
  return [...dialog.querySelectorAll(focusableSelector)].filter((element) => {
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    const rectangle = element.getBoundingClientRect();

    return style.visibility !== 'hidden'
      && style.display !== 'none'
      && rectangle.width > 0
      && rectangle.height > 0;
  });
}

function pressShiftTab() {
  const dispatch = type => Cypress.automation('remote:debugger:protocol', {
    command: 'Input.dispatchKeyEvent',
    params: {
      type,
      key: 'Tab',
      code: 'Tab',
      modifiers: 8,
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    },
  });

  return cy.then(() => dispatch('keyDown'))
    .then(() => dispatch('keyUp'));
}

function assertFocusLoopsInsideModal() {
  cy.get('@activeModal').then(($dialog) => {
    const focusable = visibleFocusableElements($dialog[0]);

    expect(focusable.length, 'focusable modal controls').to.be.greaterThan(1);
    cy.wrap(focusable.at(-1)).focus().as('lastModalControl');
    cy.wrap(focusable[0]).as('firstModalControl');
  });
  cy.press(Cypress.Keyboard.Keys.TAB);
  cy.get('@firstModalControl').should('be.focused');

  pressShiftTab();
  cy.get('@lastModalControl').should('be.focused');
}

function assertUniqueModalIds() {
  cy.get('dialog[data-accessible-modal]').should(($dialogs) => {
    const dialogIds = [...$dialogs].map(dialog => dialog.id);
    const titleIds = [...$dialogs].map(dialog => (
      dialog.getAttribute('aria-labelledby')
    ));

    expect(dialogIds.every(Boolean), 'non-empty dialog IDs').to.equal(true);
    expect(titleIds.every(Boolean), 'non-empty modal title IDs').to.equal(true);
    expect(new Set(dialogIds).size, 'unique dialog IDs').to.equal(dialogIds.length);
    expect(new Set(titleIds).size, 'unique modal title IDs').to.equal(titleIds.length);
  });
}

function selectMainAddress() {
  cy.get('#main-search-address[role="combobox"]')
    .focus()
    .type('20 avenue de Ségur');
  cy.wait('@addressSearch');
  cy.get('[role="listbox"] [role="option"]')
    .first()
    .click();
}

describe('Boîtes de dialogue publiques accessibles', () => {
  it('isole le fond, boucle le focus et restitue la bonne carte après Échap', () => {
    let lockedScrollY;
    let backgroundTop;

    cy.viewport(1400, 900);
    visitSituation([restrictionZone]);
    assertUniqueModalIds();

    visibleRestrictionTrigger('Arrosage des potagers')
      .scrollIntoView()
      .as('restrictionTrigger')
      .then(() => {
        cy.window().then((window) => {
          lockedScrollY = window.scrollY;
          expect(lockedScrollY, 'initial page scroll').to.be.greaterThan(0);
        });
      });
    cy.get('@restrictionTrigger').click();
    assertNativeModal('Je ne comprends pas cette restriction');

    cy.document().its('documentElement')
      .should('have.attr', 'data-fr-scrolling', 'false');
    cy.get('body')
      .should('have.css', 'position', 'fixed')
      .should(($body) => {
        expect($body[0].style.top).to.equal(`${-lockedScrollY}px`);
      });
    cy.get('@restrictionTrigger').then(($trigger) => {
      backgroundTop = $trigger[0].getBoundingClientRect().top;
    });
    cy.window().then((window) => {
      window.scrollTo(0, lockedScrollY + 500);
      return new Cypress.Promise((resolve) => {
        window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
      });
    });
    cy.get('@restrictionTrigger').should(($trigger) => {
      expect($trigger[0].getBoundingClientRect().top)
        .to.be.closeTo(backgroundTop, 0.5);
    });

    cy.get('@activeModal')
      .find('.fr-btn--close')
      .should('be.focused')
      .and('contain.text', 'Fermer');
    assertFocusLoopsInsideModal();

    cy.get('@restrictionTrigger').then(($trigger) => {
      const dialog = $trigger[0].ownerDocument.querySelector(
        'dialog[data-accessible-modal][open]',
      );

      $trigger[0].focus();
      const activeAfterBackgroundFocus = dialog.ownerDocument.activeElement;
      expect(
        activeAfterBackgroundFocus,
        'background trigger must not receive focus while the dialog is modal',
      )
        .not.to.equal($trigger[0]);

      dialog.querySelector('.fr-btn--close').focus();
      expect(
        dialog.contains(dialog.ownerDocument.activeElement),
        'focus restored inside modal after the programmatic background probe',
      ).to.equal(true);
    });

    cy.press(Cypress.Keyboard.Keys.ESC);
    cy.get('dialog[data-accessible-modal][open]').should('not.exist');
    cy.document().its('documentElement')
      .should('not.have.attr', 'data-fr-scrolling');
    cy.get('body').should('not.have.css', 'position', 'fixed');
    cy.window().should((window) => {
      expect(window.scrollY).to.be.closeTo(lockedScrollY, 1);
    });
    cy.get('@restrictionTrigger').should('be.focused');
    cy.location('pathname').should('equal', '/situation');

    cy.press(Cypress.Keyboard.Keys.ESC);
    cy.location('pathname').should('equal', '/situation');
    cy.get('@restrictionTrigger').should('be.focused');
  });

  it('annonce le succès du feedback 200 et conserve la modale sur erreur 500', () => {
    cy.viewport(1400, 900);
    visitSituation([restrictionZone]);

    cy.intercept('POST', '**/usage/feedback/101', {
      statusCode: 200,
      body: { id: 'feedback-101' },
    }).as('feedbackSuccess');
    visibleRestrictionTrigger('Arrosage des jardins')
      .as('successTrigger')
      .click();
    assertNativeModal('Je ne comprends pas cette restriction');
    cy.get('@activeModal').find('textarea').type('Texte à clarifier');
    cy.get('@activeModal')
      .contains('button', 'Je ne comprends pas cette restriction')
      .click();
    cy.wait('@feedbackSuccess').its('request.body.feedback')
      .should('equal', 'Texte à clarifier');
    assertNativeModal('Votre retour a été envoyé');
    cy.get('@activeModal')
      .find('[role="status"]')
      .should('have.text', 'Votre retour a bien été pris en compte !');
    cy.get('@activeModal').find('textarea').should('not.exist');
    cy.get('@activeModal').contains('button', 'Fermer').last().click();
    cy.get('@successTrigger').should('be.focused');

    cy.intercept('POST', '**/usage/feedback/102', {
      statusCode: 500,
      body: { message: 'Erreur simulée' },
    }).as('feedbackError');
    visibleRestrictionTrigger('Arrosage des potagers')
      .as('errorTrigger')
      .click();
    assertNativeModal('Je ne comprends pas cette restriction');
    cy.get('@activeModal')
      .contains('button', 'Je ne comprends pas cette restriction')
      .click();
    cy.wait('@feedbackError');
    cy.get('@activeModal')
      .find('[role="status"]')
      .should('contain.text', 'n’a pas pu être envoyé');
    cy.get('@activeModal')
      .find('h1')
      .should('not.contain.text', 'Votre retour a été envoyé');
    cy.get('@activeModal').find('textarea').should('exist');
    cy.press(Cypress.Keyboard.Keys.ESC);
    cy.get('@errorTrigger').should('be.focused');

    cy.intercept('POST', '**/usage/feedback/103', {
      statusCode: 200,
      delay: 1500,
      body: { id: 'feedback-103' },
    }).as('delayedFeedback');
    visibleRestrictionTrigger('Arrosage des espaces verts')
      .as('delayedTrigger')
      .click();
    assertNativeModal('Je ne comprends pas cette restriction');
    cy.get('@activeModal')
      .contains('button', 'Je ne comprends pas cette restriction')
      .click();
    cy.get('@delayedFeedback.all').should('have.length', 1);
    cy.press(Cypress.Keyboard.Keys.ESC);
    cy.get('dialog[data-accessible-modal][open]').should('not.exist');
    cy.get('@delayedTrigger').should('be.focused').click();
    assertNativeModal('Je ne comprends pas cette restriction');

    cy.wait('@delayedFeedback');
    cy.get('@activeModal')
      .find('[role="status"]')
      .should('have.text', '');
    cy.get('@activeModal')
      .find('h1')
      .should('not.contain.text', 'Votre retour a été envoyé');
    cy.get('@activeModal').find('textarea').should('exist');
    cy.press(Cypress.Keyboard.Keys.ESC);
    cy.get('@delayedTrigger').should('be.focused');
  });

  it('valide le choix multi-zone dans une vraie modale utilisable à 320 px', () => {
    cy.viewport(320, 800);
    visitSituation(multiZones, 'SUP');
    assertNativeModal('veuillez sélectionner la ressource');
    assertUniqueModalIds();

    cy.get('@activeModal').then(($dialog) => {
      const rectangle = $dialog[0].getBoundingClientRect();
      const viewportWidth = $dialog[0].ownerDocument.documentElement.clientWidth;

      expect(rectangle.left).to.be.at.least(0);
      expect(rectangle.right).to.be.at.most(viewportWidth);
    });
    cy.get('@activeModal').contains('button', 'Valider').click();
    cy.get('dialog[data-accessible-modal][open]').should('exist');
    cy.get('#situation-alert-zone-modal')
      .should('have.attr', 'aria-invalid', 'true')
      .and('be.focused')
      .then(($select) => {
        const descriptionId = ($select.attr('aria-describedby') || '')
          .split(/\s+/)
          .find(Boolean);
        const description = descriptionId
          ? $select[0].ownerDocument.getElementById(descriptionId)
          : null;

        expect(description, 'linked zone error').not.to.equal(null);
        expect(description.textContent).to.match(/zone|sélection/i);
      });

    cy.get('#situation-alert-zone-modal').select('zone-aval');
    cy.get('@activeModal').contains('button', 'Valider').click();
    cy.get('dialog[data-accessible-modal][open]').should('not.exist');
    cy.get('#situation-alert-zone')
      .should('have.value', 'zone-aval')
      .and('be.focused');
    cy.location('pathname').should('equal', '/situation');

    cy.press(Cypress.Keyboard.Keys.ESC);
    cy.location('pathname').should('equal', '/situation');
  });

  it('gère les erreurs de recherche 409 et 500 avec un retour de focus utile', () => {
    let zoneStatus = 409;

    cy.intercept('GET', '**/search/?q=*', {
      statusCode: 200,
      body: {
        type: 'FeatureCollection',
        features: [addressFeature],
      },
    }).as('addressSearch');
    cy.intercept('GET', '**/zones/publication', {
      statusCode: 200,
      body: validZonePublication,
    });
    cy.intercept('GET', '**/zones?*', request => request.reply({
      statusCode: zoneStatus,
      body: { message: 'Erreur simulée' },
    })).as('zoneError');
    cy.visit('/');
    selectMainAddress();

    cy.get('[data-cy="MainRestrictionSearchSubmit"]')
      .as('searchSubmit')
      .click();
    cy.wait('@zoneError');
    assertNativeModal('Nous avons besoin de plus de précision');
    cy.get('@activeModal')
      .contains('button', 'Entrer une adresse plus précise')
      .click();
    cy.get('#main-search-address').should('be.focused');

    cy.then(() => {
      zoneStatus = 500;
    });
    cy.get('@searchSubmit').click();
    cy.wait('@zoneError');
    assertNativeModal('Cela n\'a pas fonctionné comme prévu');
    cy.press(Cypress.Keyboard.Keys.ESC);
    cy.get('@searchSubmit').should('be.focused');
  });
});
