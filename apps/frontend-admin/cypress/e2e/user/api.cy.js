/* global Cypress, cy, describe, it, beforeEach, after, expect */

const emails = [];
const testEmail = () => {
  const email = 'cytest_' + Cypress._.random(1000000000) + '@example.com';
  emails.push(email);
  return email;
};
const departmentRole = (codes) => ({
  role: 'departement', roleDepartements: codes, roleCommunes: [],
});
const userPath = (email) => '/user/' + encodeURIComponent(email);
const request = (method, path, status, body) => cy.request({
  method,
  url: Cypress.env('apiUrl').replace(/\/$/, '') + path,
  ...(body === undefined ? {} : { body }),
  failOnStatusCode: false,
}).then((response) => {
  expect(response.status, method + ' ' + path).to.equal(status);
  return response;
});

function rejectInvalidUsers(email) {
  for (const body of [
    { email: 'email', ...departmentRole(['2A']) },
    { email, ...departmentRole(['2A']), role: 'role' },
    { email, role: 'departement', roleCommunes: [] },
    { email, ...departmentRole(['departement']) },
    { email },
  ]) {
    request('POST', '/user', 400, body);
  }
}

describe('API utilisateurs', () => {
  beforeEach(() => cy.logout());

  after(() => {
    cy.devLogin(Cypress.env('mteUser'));
    for (const email of emails) request('DELETE', userPath(email), 200);
  });

  it('refuse les routes utilisateurs sans authentification', () => {
    request('GET', '/user', 403);
    request('GET', '/user/me', 403);
    request('POST', '/user', 403, { email: testEmail(), role: 'mte' });
    request('PATCH', userPath(Cypress.env('departementUser')), 403, { role: 'mte' });
    request('DELETE', userPath(Cypress.env('departementUser')), 403);
  });

  it('limite un DDT a ses departements et refuse les escalades de droits', () => {
    const email = testEmail();
    cy.devLogin(Cypress.env('departementUser'));
    request('GET', '/user', 200).then(({ body }) => {
      expect(body.map((user) => user.email)).to.include(Cypress.env('departementUser'));
      expect(body.map((user) => user.email)).not.to.include(Cypress.env('departementAciUser'));
      expect(body.map((user) => user.email)).not.to.include(Cypress.env('mteUser'));
    });
    request('GET', '/user/me', 200).its('body.email').should('equal', Cypress.env('departementUser'));
    request('POST', '/user', 403, { email, role: 'mte' });
    request('POST', '/user', 403, { email, ...departmentRole(['2B']) });
    request('POST', '/user', 403, { email, ...departmentRole(['2A', '2B']) });
    rejectInvalidUsers(email);

    request('POST', '/user', 201, { email, ...departmentRole(['2A']) })
      .its('body.roleDepartements').should('deep.equal', ['2A']);
    request('POST', '/user', 403, { email, ...departmentRole(['2A']) });
    request('PATCH', userPath(email), 403, { role: 'mte' });
    request('PATCH', userPath(email), 403, departmentRole(['2B']));
    request('PATCH', userPath(Cypress.env('departementAciUser')), 403, { role: 'mte' });
    request('DELETE', userPath(Cypress.env('departementAciUser')), 403);
    request('DELETE', userPath(Cypress.env('mteUser')), 403);
    request('DELETE', userPath(email), 200);
    request('DELETE', userPath(email), 400);
    request('GET', '/user', 200).then(({ body }) => {
      expect(body.map((user) => user.email)).not.to.include(email);
    });
  });

  it('permet au MTE de gerer les roles et les droits multi-departements', () => {
    const email = testEmail();
    const mteEmail = testEmail();
    const otherDepartmentEmail = testEmail();
    cy.devLogin(Cypress.env('mteUser'));
    request('GET', '/user', 200).then(({ body }) => {
      expect(body.map((user) => user.email)).to.include.members([
        Cypress.env('departementUser'), Cypress.env('departementAciUser'), Cypress.env('mteUser'),
      ]);
    });
    request('GET', '/user/me', 200).its('body.email').should('equal', Cypress.env('mteUser'));
    rejectInvalidUsers(email);
    request('POST', '/user', 201, { email: mteEmail, role: 'mte' });
    request('POST', '/user', 201, { email: otherDepartmentEmail, ...departmentRole(['2B']) });
    request('POST', '/user', 201, { email, ...departmentRole(['2A']) });
    request('POST', '/user', 403, { email, ...departmentRole(['2A']) });

    request('PATCH', userPath(email), 200, { role: 'mte' })
      .its('body.role').should('equal', 'mte');
    request('PATCH', userPath(mteEmail), 200, departmentRole(['2B']))
      .its('body.roleDepartements').should('deep.equal', ['2B']);
    request('PATCH', userPath(mteEmail), 200, { role: 'mte' })
      .its('body.roleDepartements').should('be.null');
    request('PATCH', userPath(email), 200, departmentRole(['2A', '2B']))
      .its('body.roleDepartements').should('deep.equal', ['2A', '2B']);
    request('GET', '/user', 200).then(({ body }) => {
      expect(body.find((user) => user.email === email).roleDepartements).to.deep.equal(['2A', '2B']);
    });

    request('DELETE', userPath(email), 200);
    request('DELETE', userPath(mteEmail), 200);
    request('DELETE', userPath(otherDepartmentEmail), 200);
    request('DELETE', userPath(email), 200);
    request('GET', '/user', 200).then(({ body }) => {
      for (const removed of [email, mteEmail, otherDepartmentEmail]) {
        expect(body.map((user) => user.email)).not.to.include(removed);
      }
    });
  });
});
