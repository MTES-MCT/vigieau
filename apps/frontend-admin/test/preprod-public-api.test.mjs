import assert from 'node:assert/strict';
import test from 'node:test';
import { isPreprodPublicApiBridgeEnabled } from '../config/preprod-public-api.ts';

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
