import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditActorLabel,
  auditFiltersQuery,
  defaultAuditFilters,
  fileAccessUrl,
  formatAuditDate,
  formatAuditValue,
  matchesUserSearch,
  userExportUrl,
} from '../client/utils/audit.ts';

test('an unidentified requester is not presented as a system process', () => {
  assert.equal(auditActorLabel(undefined, 'http'), 'Auteur non identifié');
  assert.equal(auditActorLabel(undefined, 'system'), 'Système');
  assert.equal(auditActorLabel('agent@example.test', 'system'), 'agent@example.test');
});

test('audit date ranges include the whole French civil day across daylight saving changes', () => {
  const filters = { ...defaultAuditFilters(new Date('2026-10-25T10:00:00Z')), from: '2026-10-25', to: '2026-10-25' };
  const query = new URLSearchParams(auditFiltersQuery(filters));
  assert.equal(query.get('from'), '2026-10-24T22:00:00.000Z');
  assert.equal(query.get('to'), '2026-10-25T22:59:59.999Z');
  assert.equal(query.get('limit'), '50');
  assert.equal(formatAuditDate('2026-10-25T02:15:00Z'), '25/10/2026 à 03:15:00');
});

test('audit filters reject invalid or reversed dates before requesting private data', () => {
  const filters = defaultAuditFilters(new Date('2026-11-12T12:00:00Z'));
  assert.equal(filters.from, '2026-10-14');
  assert.equal(filters.to, '2026-11-12');
  assert.throws(() => auditFiltersQuery({ ...filters, from: '2026-02-30' }), /invalide/);
  assert.throws(() => auditFiltersQuery({ ...filters, from: '2026-11-13' }), /précéder/);
  assert.throws(() => auditFiltersQuery({ ...filters, to: '2026-11-12T23:00:00Z' }), /invalide/);
});

test('actor, resource and cursor values stay distinct encoded query parameters', () => {
  const filters = { ...defaultAuditFilters(), actor: 'agent+test@example.test', resourceId: '5&result=succeeded', action: 'user.update' };
  const query = new URLSearchParams(auditFiltersQuery(filters, 'opaque+/cursor='));
  assert.equal(query.get('actor'), filters.actor);
  assert.equal(query.get('resourceId'), filters.resourceId);
  assert.equal(query.get('result'), null);
  assert.equal(query.get('cursor'), 'opaque+/cursor=');
});

test('audit values retain false, zero, empty relations and literal markup for escaped rendering', () => {
  assert.equal(formatAuditValue(false), 'Non');
  assert.equal(formatAuditValue(0), '0');
  assert.equal(formatAuditValue(null), '—');
  assert.equal(formatAuditValue([]), 'Aucun');
  assert.equal(formatAuditValue([1, 2]), '1, 2');
  assert.equal(formatAuditValue('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
  assert.equal(formatAuditDate('not-a-date'), 'Date inconnue');
});

test('document requests use the authenticated audit endpoint and reject malformed identifiers', () => {
  assert.equal(fileAccessUrl(42), '/api/fichier/42/access');
  assert.equal(fileAccessUrl('789'), '/api/fichier/789/access');
  for (const id of [undefined, null, '', 0, -1, '1/../../user', '//host', '1?token=secret']) assert.equal(fileAccessUrl(id), '');
});

test('user exports keep their search server-side and do not turn search into extra parameters', () => {
  const url = new URL(userExportUrl(' émilie & role=mte '), 'https://example.test');
  assert.equal(url.pathname, '/api/user/export');
  assert.equal(url.searchParams.get('search'), 'émilie & role=mte');
  assert.equal(url.searchParams.size, 1);
  assert.equal(userExportUrl('  '), '/api/user/export');
});

test('user filtering matches backend normalization without treating search as a regular expression', () => {
  const user = { lastName: 'Dupont-Salé', firstName: 'Émilie', email: 'emilie+test@example.test', roleDepartements: ['2A', '33'] };
  assert.equal(matchesUserSearch(user, 'EMILIE'), true);
  assert.equal(matchesUserSearch(user, 'dupontsale'), true);
  assert.equal(matchesUserSearch(user, 'dupont sale'), true);
  assert.equal(matchesUserSearch(user, '2a'), true);
  assert.equal(matchesUserSearch(user, '+test'), true);
  assert.equal(matchesUserSearch(user, '.*'), false);
  assert.equal(matchesUserSearch(user, '['), false);
  assert.equal(matchesUserSearch({}, 'emilie'), false);
  assert.equal(matchesUserSearch({}, ' '), true);
});
