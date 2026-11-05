import assert from 'node:assert/strict';
import test from 'node:test';
import { isPreprodPublicApiBridgeEnabled } from '../config/preprod-public-api.ts';
import { getPublicApiVisibility } from '../client/utils/public-api-visibility.ts';

test('the admin public API bridge requires both the explicit flag and the exact preproduction application', () => {
  for (const APP of [undefined, 'regleau-front-preprod', 'regleau-front', 'preservonsleau-front-preprod']) {
    assert.equal(isPreprodPublicApiBridgeEnabled({ APP }), false);
    assert.equal(isPreprodPublicApiBridgeEnabled({ APP, VIGIEAU_PREPROD_PUBLIC_API_BRIDGE: 'false' }), false);
    if (APP !== 'regleau-front-preprod') {
      assert.throws(() => isPreprodPublicApiBridgeEnabled({ APP, VIGIEAU_PREPROD_PUBLIC_API_BRIDGE: 'true' }), /regleau-front-preprod/);
    }
  }
  assert.equal(isPreprodPublicApiBridgeEnabled({ APP: 'regleau-front-preprod', VIGIEAU_PREPROD_PUBLIC_API_BRIDGE: 'true' }), true);
  for (const value of ['TRUE', '1', 'yes', ' true ']) {
    assert.throws(
      () => isPreprodPublicApiBridgeEnabled({ APP: 'regleau-front-preprod', VIGIEAU_PREPROD_PUBLIC_API_BRIDGE: value }),
      /must be true or false/,
    );
  }
});

test('only a valid empty array allows the no-prefectural-order confirmation', () => {
  assert.equal(getPublicApiVisibility([], null), 'empty');
  assert.equal(getPublicApiVisibility([{ id: 1 }], null), 'visible');
  for (const response of [null, undefined, {}, '', '<html>Sign in</html>']) {
    assert.equal(getPublicApiVisibility(response, null), 'unavailable');
  }
});

test('the existing overlapping-zone response still confirms visibility', () => {
  assert.equal(getPublicApiVisibility(null, { statusCode: 409 }), 'visible');
});

test('the proxy authentication error requests a session, while a business 401 remains a verification failure', () => {
  assert.equal(getPublicApiVisibility(null, { statusCode: 401, data: { error: 'preprod_auth_required' } }), 'authentication-required');
  assert.equal(getPublicApiVisibility(null, { status: 401, data: { error: 'preprod_auth_required' } }), 'authentication-required');
  for (const data of [undefined, null, '', [], {}, { error: 'Unauthorized' }, { error: 'preprod_auth_required', message: 'Invalid token' }]) {
    assert.equal(getPublicApiVisibility(null, { statusCode: 401, data }), 'unavailable');
  }
  assert.equal(getPublicApiVisibility(null, { statusCode: 401, data: { message: 'Invalid token' } }), 'unavailable');
  assert.equal(
    getPublicApiVisibility(null, { statusCode: 401, data: { statusCode: 401, error: 'Unauthorized', message: 'Invalid token' } }),
    'unavailable',
  );
});

test('authorization failures and network failures cannot authorize a save or the empty-result confirmation', () => {
  assert.equal(getPublicApiVisibility(null, { statusCode: 403 }), 'forbidden');
  for (const error of [new Error('Failed to fetch'), { statusCode: 500 }, { statusCode: 504 }]) {
    assert.equal(getPublicApiVisibility([], error), 'unavailable');
  }
});
