import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

for (const file of [
  '../apps/frontend/client/utils/index.ts',
  '../apps/frontend-admin/client/composables/useUtils.ts',
]) {
  test(`${file}: requires a working WebGL2 context`, async () => {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    const body = source.match(/isWebglSupported\(\)\s*\{([\s\S]*?)^\s*\},/m)?.[1];
    assert.ok(body, 'The actual capability helper must be tested');
    const supports = new Function('window', 'document', body);
    const calls = [];
    const context = { getParameter() {} };
    const document = { createElement: () => ({ getContext: (kind) => {
      calls.push(kind);
      return context;
    } }) };
    assert.equal(supports({ WebGL2RenderingContext: class {} }, document), true);
    assert.deepEqual(calls, ['webgl2']);
    calls.length = 0;
    assert.equal(supports({ WebGLRenderingContext: class {} }, document), false);
    assert.deepEqual(calls, [], 'WebGL1 must not be used as a substitute');
    for (const getContext of [() => null, () => ({}), () => { throw new Error('disabled'); }]) {
      assert.equal(supports({ WebGL2RenderingContext: class {} }, {
        createElement: () => ({ getContext }),
      }), false);
    }
    assert.equal(supports({}, document), false);
  });
}
