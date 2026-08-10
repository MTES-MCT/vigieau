/* global cy, Cypress, describe, expect, it */

const addressFeatures = [
  {
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
  },
  {
    type: 'Feature',
    geometry: { coordinates: [2.31, 48.851] },
    properties: {
      id: '75107_8240_00022',
      type: 'housenumber',
      label: '22 Avenue de Ségur 75007 Paris',
      postcode: '75007',
      citycode: '75107',
      context: '75, Paris, Île-de-France',
    },
  },
];

const combobox = () => cy.get(
  '[data-cy="AddressSearchInput"] input[role="combobox"]',
);

function stubAddressSearch(handler) {
  cy.intercept('GET', '**/search/?q=*', handler).as('addressSearch');
}

function assertInputKeepsFocus() {
  combobox().should(($input) => {
    expect($input[0].ownerDocument.activeElement).to.equal($input[0]);
  });
}

describe('Combobox d’adresse accessible', () => {
  it('expose un nom, une aide, un état obligatoire et des relations stables', () => {
    cy.visit('/');

    combobox().should(($input) => {
      const input = $input[0];
      const document = input.ownerDocument;
      const label = document.querySelector(`label[for="${input.id}"]`);
      const listbox = document.getElementById(input.getAttribute('aria-controls'));
      const descriptions = (input.getAttribute('aria-describedby') || '')
        .split(/\s+/)
        .filter(Boolean)
        .map(id => document.getElementById(id));

      expect(label).not.to.equal(null);
      expect(label.textContent).to.include('Entrez votre adresse complète');
      expect(label.textContent).not.to.include('Ex: 20 avenue de Ségur');
      expect(input.required).to.equal(true);
      expect(input.getAttribute('autocomplete')).to.equal('street-address');
      expect(input.getAttribute('aria-autocomplete')).to.equal('list');
      expect(input.getAttribute('aria-haspopup')).to.equal('listbox');
      expect(input.getAttribute('aria-expanded')).to.equal('false');
      expect(input.hasAttribute('aria-activedescendant')).to.equal(false);
      expect(listbox?.getAttribute('role')).to.equal('listbox');
      expect(listbox?.getAttribute('aria-label')).to.match(/adresses/);
      expect(descriptions).to.have.length.greaterThan(0);
      expect(descriptions.some(description => (
        description?.textContent.includes('Ex: 20 avenue de Ségur')
      ))).to.equal(true);
      expect(descriptions.every(description => !label.contains(description)))
        .to.equal(true);
    });

    cy.get('[data-cy="AddressSearchStatus"]')
      .should('have.attr', 'role', 'status')
      .and('have.attr', 'aria-live', 'polite')
      .and('have.attr', 'aria-atomic', 'true');
    cy.get('[data-cy="AddressSearchSubmit"]')
      .should('have.prop', 'tagName', 'BUTTON')
      .and('contain.text', 'Rechercher une adresse');
  });

  it('garde le focus dans le champ et expose l’option active au clavier', () => {
    stubAddressSearch({
      delay: 600,
      statusCode: 200,
      body: { type: 'FeatureCollection', features: addressFeatures },
    });
    cy.visit('/');

    combobox().focus().type('20 avenue de Ségur');
    cy.wait(550);
    cy.get('[data-cy="AddressSearchStatus"]')
      .should('contain.text', 'cours');
    cy.wait('@addressSearch');
    combobox()
      .should('have.attr', 'aria-expanded', 'true')
      .and('not.have.attr', 'aria-activedescendant');
    cy.get('[data-cy="AddressSearchStatus"]')
      .should('contain.text', '2')
      .and('contain.text', 'suggestions');
    cy.get('[role="listbox"] [role="option"]')
      .should('have.length', 2)
      .and('not.have.attr', 'tabindex', '0');
    cy.get('[role="listbox"]').should('not.have.attr', 'tabindex', '1');

    combobox().type('{downarrow}');
    assertInputKeepsFocus();
    combobox().invoke('attr', 'aria-activedescendant').then((activeId) => {
      expect(activeId).to.be.a('string');
      expect(activeId.length).to.be.greaterThan(0);
      cy.get(`#${activeId}`).should('have.attr', 'aria-selected', 'true');
    });

    combobox().type('{downarrow}');
    assertInputKeepsFocus();
    combobox().invoke('attr', 'aria-activedescendant').then((activeId) => {
      cy.get(`#${activeId}`)
        .should('contain.text', '22 Avenue de Ségur')
        .and('have.attr', 'aria-selected', 'true');
    });

    combobox().type('{esc}')
      .should('have.attr', 'aria-expanded', 'false')
      .and('not.have.attr', 'aria-activedescendant');
    assertInputKeepsFocus();

    combobox().type('{downarrow}{downarrow}{enter}')
      .should('have.value', '22 Avenue de Ségur 75007 Paris')
      .and('have.attr', 'aria-expanded', 'false')
      .and('not.have.attr', 'aria-activedescendant');
    assertInputKeepsFocus();
  });

  it('ferme la liste avec Tab et laisse le focus poursuivre son parcours', () => {
    stubAddressSearch({
      statusCode: 200,
      body: { type: 'FeatureCollection', features: addressFeatures },
    });
    cy.visit('/');

    combobox().focus().type('Paris');
    cy.wait('@addressSearch');
    combobox().should('have.attr', 'aria-expanded', 'true');
    cy.press(Cypress.Keyboard.Keys.TAB);
    combobox()
      .should('have.attr', 'aria-expanded', 'false')
      .and('not.have.attr', 'aria-activedescendant');
    cy.get('[data-cy="AddressSearchSubmit"]').should('have.focus');
  });

  it('annonce zéro résultat et les erreurs de recherche', () => {
    stubAddressSearch((request) => {
      const query = new URL(request.url).searchParams.get('q');
      if (query?.includes('erreur')) {
        request.reply({ statusCode: 503, body: { message: 'indisponible' } });
        return;
      }
      request.reply({
        statusCode: 200,
        body: { type: 'FeatureCollection', features: [] },
      });
    });
    cy.visit('/');

    combobox().focus().type('aucun résultat');
    cy.wait('@addressSearch');
    cy.get('[data-cy="AddressSearchStatus"]')
      .should('contain.text', 'Aucune adresse');
    combobox().should('have.attr', 'aria-expanded', 'false');
    combobox().type('{downarrow}{uparrow}{enter}{esc}');
    combobox().should('have.value', 'aucun résultat');
    assertInputKeepsFocus();
    cy.get('[data-cy="AddressSearchSubmit"]').click();
    assertInputKeepsFocus();

    combobox().clear().type('erreur réseau');
    cy.wait('@addressSearch');
    cy.get('[data-cy="AddressSearchStatus"]')
      .should('contain.text', 'recherche')
      .and('contain.text', 'réessayer');
    combobox().should('have.attr', 'aria-expanded', 'false');
  });

  it('ignore une réponse ancienne arrivée après la recherche courante', () => {
    const staleFeature = structuredClone(addressFeatures[0]);
    staleFeature.properties.label = 'Ancienne réponse 75000 Paris';
    const currentFeature = structuredClone(addressFeatures[1]);
    currentFeature.properties.label = 'Réponse actuelle 75007 Paris';

    stubAddressSearch((request) => {
      const query = new URL(request.url).searchParams.get('q');
      request.reply({
        delay: query?.includes('ancienne') ? 1_200 : 0,
        statusCode: 200,
        body: {
          type: 'FeatureCollection',
          features: [query?.includes('ancienne') ? staleFeature : currentFeature],
        },
      });
    });
    cy.visit('/');

    combobox().focus().type('ancienne');
    cy.wait(600);
    combobox().clear().type('actuelle');
    cy.wait(1_800);

    combobox().should('have.value', 'actuelle');
    cy.get('[role="listbox"] [role="option"]')
      .should('have.length', 1)
      .and('contain.text', 'Réponse actuelle')
      .and('not.contain.text', 'Ancienne réponse');
  });

  it('replace le focus après le bouton Rechercher, avec ou sans suggestion', () => {
    stubAddressSearch({
      statusCode: 200,
      body: { type: 'FeatureCollection', features: addressFeatures },
    });
    cy.visit('/');

    cy.get('[data-cy="AddressSearchSubmit"]').click();
    assertInputKeepsFocus();

    combobox().type('Paris');
    cy.wait('@addressSearch');
    cy.get('[data-cy="AddressSearchSubmit"]').click();
    combobox()
      .should('have.value', '20 Avenue de Ségur 75007 Paris')
      .and('have.attr', 'aria-expanded', 'false');
    assertInputKeepsFocus();
  });

  it('sélectionne aussi une suggestion à la souris sans ajouter de tab stop', () => {
    stubAddressSearch({
      statusCode: 200,
      body: { type: 'FeatureCollection', features: addressFeatures },
    });
    cy.visit('/');

    combobox().focus().type('Ségur');
    cy.wait('@addressSearch');
    cy.get('[role="listbox"] [role="option"]')
      .eq(1)
      .click();
    combobox()
      .should('have.value', '22 Avenue de Ségur 75007 Paris')
      .and('have.attr', 'aria-expanded', 'false');
    assertInputKeepsFocus();
  });

  it('invalide immédiatement une ancienne sélection après édition manuelle', () => {
    stubAddressSearch({
      statusCode: 200,
      body: { type: 'FeatureCollection', features: addressFeatures },
    });
    cy.visit('/');

    cy.contains('button', 'Je consulte les restrictions').should('be.disabled');
    combobox().focus().type('Ségur');
    cy.wait('@addressSearch');
    cy.get('[role="listbox"] [role="option"]').first().click();
    cy.contains('button', 'Je consulte les restrictions')
      .should('not.be.disabled');

    combobox().type(' modifiée');
    cy.contains('button', 'Je consulte les restrictions').should('be.disabled');
  });

  it('conserve les mêmes garanties dans le formulaire d’abonnement', () => {
    stubAddressSearch({
      statusCode: 200,
      body: { type: 'FeatureCollection', features: addressFeatures },
    });
    cy.visit('/abonnements/nouveau');

    combobox().should('have.attr', 'required');
    combobox().should('have.attr', 'autocomplete', 'street-address');
    combobox().should('have.attr', 'aria-describedby');
    combobox().focus().type('20 avenue de Ségur');
    cy.wait('@addressSearch').its('request.url').then((url) => {
      expect(new URL(url).searchParams.get('type')).to.equal('housenumber');
    });
  });

  it('reste utilisable et contenu dans la largeur utile à 320 px', () => {
    stubAddressSearch({
      statusCode: 200,
      body: { type: 'FeatureCollection', features: addressFeatures },
    });
    cy.viewport(320, 800);
    cy.visit('/');

    combobox().focus().type('Paris');
    cy.wait('@addressSearch');
    cy.get('[role="listbox"]').should('be.visible');
    cy.get('[data-cy="AddressSearchInput"]').should(($wrapper) => {
      const wrapper = $wrapper[0];
      const viewportWidth = wrapper.ownerDocument.documentElement.clientWidth;
      const elements = [
        wrapper,
        ...wrapper.querySelectorAll('input, button, [role="listbox"]'),
      ];

      elements.forEach((element) => {
        const rect = element.getBoundingClientRect();
        expect(rect.left, element.tagName).to.be.at.least(0);
        expect(rect.right, element.tagName).to.be.at.most(viewportWidth);
      });
    });
  });
});

describe('Géolocalisation accessible', () => {
  it('annonce le succès et replace le focus dans le champ', () => {
    cy.intercept('GET', '**/search/?q=*').as('unexpectedAddressSearch');
    cy.intercept('GET', '**/communes?lon=*&lat=*', {
      statusCode: 200,
      body: [{
        code: '75056',
        nom: 'Paris',
        codeDepartement: '75',
        mairie: { coordinates: [2.3522, 48.8566] },
        centre: { coordinates: [2.3522, 48.8566] },
      }],
    }).as('reverseGeolocation');
    cy.visit('/', {
      onBeforeLoad(window) {
        Object.defineProperty(window.navigator, 'geolocation', {
          configurable: true,
          value: {
            getCurrentPosition(success) {
              success({ coords: { longitude: 2.3522, latitude: 48.8566 } });
            },
          },
        });
      },
    });

    combobox().focus().type('saisie à annuler');
    cy.get('[data-cy="GeolocationButton"]').click();
    cy.wait('@reverseGeolocation');
    combobox().should('have.value', 'Paris');
    cy.get('[data-cy="AddressSearchStatus"]')
      .should('contain.text', 'Paris');
    assertInputKeepsFocus();
    cy.wait(600);
    cy.get('@unexpectedAddressSearch.all').should('have.length', 0);
  });

  it('annonce le refus et replace le focus dans le champ', () => {
    cy.visit('/', {
      onBeforeLoad(window) {
        Object.defineProperty(window.navigator, 'geolocation', {
          configurable: true,
          value: {
            getCurrentPosition(_success, error) {
              error({ code: 1, message: 'Permission refusée' });
            },
          },
        });
      },
    });

    cy.get('[data-cy="GeolocationButton"]').click();
    cy.get('[data-cy="AddressSearchStatus"]')
      .should('contain.text', 'géolocalisation')
      .and('contain.text', 'adresse');
    assertInputKeepsFocus();
  });

  it('annonce une réponse géographique vide et replace le focus', () => {
    cy.intercept('GET', '**/communes?lon=*&lat=*', {
      statusCode: 200,
      body: [],
    }).as('reverseGeolocation');
    cy.visit('/', {
      onBeforeLoad(window) {
        Object.defineProperty(window.navigator, 'geolocation', {
          configurable: true,
          value: {
            getCurrentPosition(success) {
              success({ coords: { longitude: 2.3522, latitude: 48.8566 } });
            },
          },
        });
      },
    });

    cy.get('[data-cy="GeolocationButton"]').click();
    cy.wait('@reverseGeolocation');
    cy.get('[data-cy="AddressSearchStatus"]')
      .should('contain.text', 'géolocalisation')
      .and('contain.text', 'adresse');
    assertInputKeepsFocus();
  });

  it('annonce une erreur de l’API géographique et replace le focus', () => {
    cy.intercept('GET', '**/communes?lon=*&lat=*', {
      statusCode: 503,
      body: { message: 'indisponible' },
    }).as('reverseGeolocation');
    cy.visit('/', {
      onBeforeLoad(window) {
        Object.defineProperty(window.navigator, 'geolocation', {
          configurable: true,
          value: {
            getCurrentPosition(success) {
              success({ coords: { longitude: 2.3522, latitude: 48.8566 } });
            },
          },
        });
      },
    });

    cy.get('[data-cy="GeolocationButton"]').click();
    cy.wait('@reverseGeolocation');
    cy.get('[data-cy="AddressSearchStatus"]')
      .should('contain.text', 'géolocalisation')
      .and('contain.text', 'adresse');
    assertInputKeepsFocus();
  });
});
