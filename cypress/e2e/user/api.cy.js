describe('API utilisateurs', () => {
  beforeEach(() => {
    cy.logout();
  });

  after(() => {
    cy.resetDb('user');
  });

  it(`Les routes de l'API ne doivent pas être accessible si on est pas connecté`, () => {
    cy.request({
      url: '/api/user',
      failOnStatusCode:false,
    }).then((resp) => {
      expect(resp.status).to.eq(403)
    })

    cy.request({
      url: '/api/user/me',
      failOnStatusCode:false,
    }).then((resp) => {
      expect(resp.status).to.eq(403)
    })

    cy.request({
      method: 'POST',
      url: '/api/user',
      body: {
        email: 'CYTEST@test.fr',
        role: 'mte'
      },
      failOnStatusCode:false,
    }).then((resp) => {
      expect(resp.status).to.eq(403)
    })

    cy.request({
      method: 'PATCH',
      url: '/api/user/2A@test.fr',
      body: {
        role: 'mte'
      },
      failOnStatusCode:false,
    }).then((resp) => {
      expect(resp.status).to.eq(403)
    })

    cy.request({
      method: 'DELETE',
      url: '/api/user/2A@test.fr',
      failOnStatusCode:false,
    }).then((resp) => {
      expect(resp.status).to.eq(403)
    })
  });

  describe('En tant que département', () => {
    const userEmail = `CYTEST${Math.floor(Math.random() * 10000)}@example.com`;

    it(`Test de l'API`, () => {
      cy.devLogin(Cypress.env('departementUser'));

      cy.request({
        url: '/api/user',
        failOnStatusCode: true,
      }).then((resp) => {
        expect(resp.status).to.eq(200)
      })
      cy.request({
        url: '/api/user/me',
        failOnStatusCode: true,
      }).then((resp) => {
        expect(resp.status).to.eq(200)
      })

      // Création d'un utilisateur MTE impossible
      cy.request({
        method: 'POST',
        url: '/api/user',
        body: {
          email: userEmail,
          role: 'mte'
        },
        failOnStatusCode:false,
      }).then((resp) => {
        expect(resp.status).to.eq(403)
      })

      // Création d'un utilisateur sur un autre département impossible
      cy.request({
        method: 'POST',
        url: '/api/user',
        body: {
          email: userEmail,
          role: 'departement',
          roleDepartement: '2B'
        },
        failOnStatusCode:false,
      }).then((resp) => {
        expect(resp.status).to.eq(403)
      })

      // Création d'un utilisateur avec email invalide impossible
      cy.request({
        method: 'POST',
        url: '/api/user',
        body: {
          email: 'email',
          role: 'departement',
          roleDepartement: '2A'
        },
        failOnStatusCode:false,
      }).then((resp) => {
        expect(resp.status).to.eq(400)
      })

      // Création d'un utilisateur avec role invalide impossible
      cy.request({
        method: 'POST',
        url: '/api/user',
        body: {
          email: userEmail,
          role: 'role',
          roleDepartement: '2A'
        },
        failOnStatusCode:false,
      }).then((resp) => {
        expect(resp.status).to.eq(400)
      })

      // Création d'un utilisateur avec département vide impossible
      cy.request({
        method: 'POST',
        url: '/api/user',
        body: {
          email: userEmail,
          role: 'departement',
        },
        failOnStatusCode:false,
      }).then((resp) => {
        expect(resp.status).to.eq(400)
      })

      // Création d'un utilisateur avec département invalide impossible
      cy.request({
        method: 'POST',
        url: '/api/user',
        body: {
          email: userEmail,
          role: 'departement',
          roleDepartement: 'departement'
        },
        failOnStatusCode:false,
      }).then((resp) => {
        expect(resp.status).to.eq(400)
      })
      
      // Création d'un utilisateur en double impossible
      cy.request({
        method: 'POST',
        url: '/api/user',
        body: {
          email: userEmail,
          role: 'departement',
          roleDepartement: '2A'
        },
        failOnStatusCode:true,
      }).then((resp) => {
        expect(resp.status).to.eq(201)
      })
      cy.request({
        method: 'POST',
        url: '/api/user',
        body: {
          email: userEmail,
          role: 'departement',
          roleDepartement: '2A'
        },
        failOnStatusCode:false,
      }).then((resp) => {
        expect(resp.status).to.eq(403)
      })

      // Création d'un utilisateur avec body vide impossible
      cy.request({
        method: 'POST',
        url: '/api/user',
        body: {
          email: userEmail,
        },
        failOnStatusCode:false,
      }).then((resp) => {
        expect(resp.status).to.eq(400)
      })

      // Modification d'un utilisateur avec rôle MTE impossible
      cy.request({
        method: 'PATCH',
        url: `/api/user/${userEmail}`,
        body: {
          role: 'mte'
        },
        failOnStatusCode:false,
      }).then((resp) => {
        expect(resp.status).to.eq(403)
      })

      // Modification d'un utilisateur sur un autre département impossible
      cy.request({
        method: 'PATCH',
        url: `/api/user/${userEmail}`,
        body: {
          role: 'departement',
          roleDepartement: '2B'
        },
        failOnStatusCode:false,
      }).then((resp) => {
        expect(resp.status).to.eq(403)
      })

      // Modification d'un autre utilisateur sur un autre département impossible
      cy.request({
        method: 'PATCH',
        url: `/api/user/${userEmail}`,
        body: {
          role: 'departement',
          roleDepartement: '2B'
        },
        failOnStatusCode:false,
      }).then((resp) => {
        expect(resp.status).to.eq(403)
      })

      // Suppression d'un utilisateur sur un autre département impossible
      cy.request({
        method: 'DELETE',
        url: `/api/user/${Cypress.env('departementAciUser')}`,
        failOnStatusCode:false,
      }).then((resp) => {
        expect(resp.status).to.eq(403)
      })

      // Suppression d'un utilisateur MTE impossible
      cy.request({
        method: 'DELETE',
        url: `/api/user/${Cypress.env('mteUser')}`,
        failOnStatusCode:false,
      }).then((resp) => {
        expect(resp.status).to.eq(403)
      })

      // Suppression d'un utilisateur sur son département
      cy.request({
        method: 'DELETE',
        url: `/api/user/${userEmail}`,
        failOnStatusCode:true,
      }).then((resp) => {
        expect(resp.status).to.eq(200)
      })

      // Suppression d'un utilisateur inexistant
      cy.request({
        method: 'DELETE',
        url: `/api/user/${userEmail}`,
        failOnStatusCode:false,
      }).then((resp) => {
        expect(resp.status).to.eq(400)
      })
    });
  });

  describe('En tant que MTE', () => {
    const userEmail = `CYTEST${Math.floor(Math.random() * 10000)}@example.com`;
    const userMteEmail = `CYTEST${Math.floor(Math.random() * 10000)}@example.com`;

    it(`Test de l'API`, () => {
      cy.devLogin(Cypress.env('mteUser'));

      cy.request({
        url: '/api/user',
        failOnStatusCode: true,
      }).then((resp) => {
        expect(resp.status).to.eq(200)
      })
      cy.request({
        url: '/api/user/me',
        failOnStatusCode: true,
      }).then((resp) => {
        expect(resp.status).to.eq(200)
      })

      // Création d'un utilisateur avec email invalide impossible
      cy.request({
        method: 'POST',
        url: '/api/user',
        body: {
          email: 'email',
          role: 'departement',
          roleDepartement: '2A'
        },
        failOnStatusCode:false,
      }).then((resp) => {
        expect(resp.status).to.eq(400)
      })

      // Création d'un utilisateur avec role invalide impossible
      cy.request({
        method: 'POST',
        url: '/api/user',
        body: {
          email: userEmail,
          role: 'role',
          roleDepartement: '2A'
        },
        failOnStatusCode:false,
      }).then((resp) => {
        expect(resp.status).to.eq(400)
      })

      // Création d'un utilisateur avec département vide impossible
      cy.request({
        method: 'POST',
        url: '/api/user',
        body: {
          email: userEmail,
          role: 'departement',
        },
        failOnStatusCode:false,
      }).then((resp) => {
        expect(resp.status).to.eq(400)
      })

      // Création d'un utilisateur avec département invalide impossible
      cy.request({
        method: 'POST',
        url: '/api/user',
        body: {
          email: userEmail,
          role: 'departement',
          roleDepartement: 'departement'
        },
        failOnStatusCode:false,
      }).then((resp) => {
        expect(resp.status).to.eq(400)
      })

      // Création d'un utilisateur MTE possible
      cy.request({
        method: 'POST',
        url: '/api/user',
        body: {
          email: userMteEmail,
          role: 'mte'
        },
        failOnStatusCode: true,
      }).then((resp) => {
        expect(resp.status).to.eq(201)
      })

      // Création d'un utilisateur sur un autre département possible
      cy.request({
        method: 'POST',
        url: '/api/user',
        body: {
          email: `CYTEST${Math.floor(Math.random() * 10000)}@example.com`,
          role: 'departement',
          roleDepartement: '2B'
        },
        failOnStatusCode: true,
      }).then((resp) => {
        expect(resp.status).to.eq(201)
      })

      // Création d'un utilisateur en double impossible
      cy.request({
        method: 'POST',
        url: '/api/user',
        body: {
          email: userEmail,
          role: 'departement',
          roleDepartement: '2A'
        },
        failOnStatusCode: true,
      }).then((resp) => {
        expect(resp.status).to.eq(201)
      })
      cy.request({
        method: 'POST',
        url: '/api/user',
        body: {
          email: userEmail,
          role: 'departement',
          roleDepartement: '2A'
        },
        failOnStatusCode: false,
      }).then((resp) => {
        expect(resp.status).to.eq(403)
      })

      // Création d'un utilisateur avec body vide impossible
      cy.request({
        method: 'POST',
        url: '/api/user',
        body: {
          email: userEmail,
        },
        failOnStatusCode: false,
      }).then((resp) => {
        expect(resp.status).to.eq(400)
      })

      // Modification d'un utilisateur avec rôle MTE possible
      cy.request({
        method: 'PATCH',
        url: `/api/user/${userEmail}`,
        body: {
          role: 'mte'
        },
        failOnStatusCode: true,
      }).then((resp) => {
        expect(resp.status).to.eq(200)
      })

      // Modification d'un utilisateur sur un autre département possible
      cy.request({
        method: 'PATCH',
        url: `/api/user/${userMteEmail}`,
        body: {
          role: 'departement',
          roleDepartement: '2B'
        },
        failOnStatusCode: true,
      }).then((resp) => {
        expect(resp.status).to.eq(200)
      })
      cy.request({
        method: 'PATCH',
        url: `/api/user/${userMteEmail}`,
        body: {
          role: 'mte'
        },
        failOnStatusCode: true,
      }).then((resp) => {
        expect(resp.status).to.eq(200)
      })

      // Modification d'un autre utilisateur sur un autre département possible
      cy.request({
        method: 'PATCH',
        url: `/api/user/${userEmail}`,
        body: {
          role: 'departement',
          roleDepartement: '2B'
        },
        failOnStatusCode: true,
      }).then((resp) => {
        expect(resp.status).to.eq(200)
      })

      // Suppression d'un utilisateur sur un autre département possible
      cy.request({
        method: 'DELETE',
        url: `/api/user/${userEmail}`,
        failOnStatusCode: true,
      }).then((resp) => {
        expect(resp.status).to.eq(200)
      })

      // Suppression d'un utilisateur MTE possible
      cy.request({
        method: 'DELETE',
        url: `/api/user/${userMteEmail}`,
        failOnStatusCode: true,
      }).then((resp) => {
        expect(resp.status).to.eq(200)
      })

      // Suppression d'un utilisateur inexistant
      // Pas de check quand on est MTE
      cy.request({
        method: 'DELETE',
        url: `/api/user/${userEmail}`,
        failOnStatusCode: false,
      }).then((resp) => {
        expect(resp.status).to.eq(200)
      })
    });

  });

})