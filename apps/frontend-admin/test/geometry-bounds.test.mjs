import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { LngLatBounds } from 'maplibre-gl';
import { getGeometryBounds } from '../client/utils/geometry-bounds.ts';

const triangle = { type: 'Polygon', coordinates: [[[2, 46], [2.8, 46.8], [2, 46.8], [2, 46]]] };

test('a triangular closed ring is not mistaken for a four-number bounding box', () => {
  assert.throws(() => new LngLatBounds().extend(triangle.coordinates[0]), /Invalid LngLat/);
  const bounds = getGeometryBounds([triangle]);
  assert.deepEqual(bounds, [[2, 46], [2.8, 46.8]]);
  assert.deepEqual(new LngLatBounds(bounds).toArray(), bounds);
});

test('includes every corner, not just the first two positions', () => {
  const geometry = { type: 'Polygon', coordinates: [[[3, 45], [1, 47], [5, 48], [7, 44], [3, 45]]] };
  assert.deepEqual(getGeometryBounds([geometry]), [[1, 44], [7, 48]]);
});

test('walks Polygon holes and MultiPolygon nesting without changing geometries', () => {
  const polygon = { type: 'Polygon', coordinates: [
    [[0, 40], [8, 40], [8, 50], [0, 50], [0, 40]],
    [[2, 43], [2, 47], [6, 47], [6, 43], [2, 43]],
  ] };
  const multiPolygon = { type: 'MultiPolygon', coordinates: [polygon.coordinates, triangle.coordinates] };
  const original = JSON.stringify(multiPolygon);
  assert.deepEqual(getGeometryBounds([polygon]), [[0, 40], [8, 50]]);
  assert.deepEqual(getGeometryBounds([multiPolygon]), [[0, 40], [8, 50]]);
  assert.equal(JSON.stringify(multiPolygon), original);
});

test('combines nested GeometryCollections and ignores optional altitude', () => {
  const collection = { type: 'GeometryCollection', geometries: [triangle, {
    type: 'GeometryCollection', geometries: [
      { type: 'Point', coordinates: [-2, 44, 123] },
      { type: 'LineString', coordinates: [[4, 47], [5, 49]] },
    ],
  }] };
  assert.deepEqual(getGeometryBounds([collection]), [[-2, 44], [5, 49]]);
});

test('empty or malformed geometry provides no viewport instead of NaN bounds', () => {
  for (const geometries of [[], [null, undefined], [{ type: 'Polygon', coordinates: [] }],
    [{ type: 'MultiPolygon', coordinates: [[[]]] }], [{ type: 'GeometryCollection', geometries: [] }],
    [{ type: 'Point', coordinates: [Number.NaN, 45] }], [{ type: 'Point', coordinates: [2, Infinity] }],
    [{ type: 'Point', coordinates: ['2', 45] }], [{ type: 'Point', coordinates: [2, 95] }]]) {
    assert.equal(getGeometryBounds(geometries), null);
  }
});

test('all three administrative maps share the safe bounds helper and skip empty fitBounds', async () => {
  for (const component of ['arreteRestriction/carte/recapitulatif', 'arreteRestriction/form/zonesMap', 'arreteCadre/carte/commune']) {
    const source = await readFile(new URL(`../client/components/${component}.vue`, import.meta.url), 'utf8');
    assert.match(source, /import \{ getGeometryBounds \} from '~\/utils\/geometry-bounds'/);
    assert.match(source, /const computeBounds = \(\) => \{[\s\S]*?if \(!bounds\) return;[\s\S]*?fitBounds\(bounds/);
    assert.doesNotMatch(source, /bounds\.extend\(/);
  }
});
