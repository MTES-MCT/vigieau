import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSituationQuery, parseSituationPoint } from '../client/utils/situation-link.ts';

test('old address-only links do not become point searches', () => {
  assert.deepEqual(parseSituationPoint({ adresse: 'Paris', commune: '75056' }), { kind: 'absent' });
});

test('point links preserve zero coordinates and valid optional commune identifiers', () => {
  const result = parseSituationPoint({ lon: '0', lat: '0', commune: '2A004', adresse: 'Point & + #' });
  assert.equal(result.kind, 'point');
  assert.deepEqual(result.address.geometry.coordinates, [0, 0]);
  assert.equal(result.address.properties.citycode, '2A004');
  assert.equal(result.address.properties.type, 'point');
  assert.equal(result.address.properties.label, 'Point & + #');
  assert.deepEqual(buildSituationQuery(result.address, null, 'particulier', 'AEP'), {
    lon: '0', lat: '0', commune: '2A004', adresse: 'Point & + #', profil: 'particulier', typeEau: 'AEP',
  });
});

test('point links retain precision through URL serialization and parsing', () => {
  const initial = parseSituationPoint({ lon: '-0.0000001', lat: '-21.23456789', commune: '97411' });
  const query = buildSituationQuery(initial.address, null, 'exploitation', 'SUP');
  const roundTrip = parseSituationPoint(Object.fromEntries(new URLSearchParams(query)));
  assert.deepEqual(roundTrip.address.geometry.coordinates, [-0.0000001, -21.23456789]);
  assert.equal(roundTrip.address.properties.citycode, '97411');
});

test('a point needs no geocodable label or commune and invalid commune data is omitted', () => {
  for (const commune of [undefined, '', 'invalid', '75056&lat=12', ['75056'], '000000']) {
    const result = parseSituationPoint({ lon: '180', lat: '-90', commune });
    assert.equal(result.kind, 'point');
    assert.equal(result.address.properties.citycode, '');
    assert.equal(result.address.properties.label, 'Point sur la carte (-90, 180)');
    assert.equal(Object.hasOwn(buildSituationQuery(result.address, null, 'particulier', 'AEP'), 'commune'), false);
  }
});

test('missing, ambiguous and invalid coordinates cannot fall back to an address or commune', () => {
  for (const query of [
    { lon: '0' }, { lat: '0' }, { lon: '', lat: '0' }, { lon: ' ', lat: '0' },
    { lon: 'NaN', lat: '0' }, { lon: 'Infinity', lat: '0' }, { lon: '0x10', lat: '0' },
    { lon: '181', lat: '0' }, { lon: '0', lat: '91' }, { lon: '-181', lat: '0' },
    { lon: '0', lat: '-91' }, { lon: ['0', '1'], lat: '0' }, { lon: '0', lat: null },
  ]) {
    assert.deepEqual(parseSituationPoint({ adresse: 'Paris', commune: '75056', ...query }), { kind: 'invalid' });
  }
});

test('new address and commune searches do not carry previous point coordinates', () => {
  const point = parseSituationPoint({ lon: '0', lat: '0', commune: '75056' }).address;
  const address = {
    geometry: { coordinates: [2.308, 48.85] },
    properties: { ...point.properties, type: 'housenumber', label: '20 avenue de Ségur' },
  };
  assert.deepEqual(buildSituationQuery(address, null, 'particulier', 'AEP'), {
    profil: 'particulier', typeEau: 'AEP', adresse: '20 avenue de Ségur',
  });
  assert.deepEqual(buildSituationQuery(null, { nom: 'Paris', codeDepartement: '75' }, 'particulier', 'AEP'), {
    profil: 'particulier', typeEau: 'AEP', adresse: 'Paris, 75',
  });
});

test('invalid internal point coordinates never generate an address-only fallback link', () => {
  const point = parseSituationPoint({ lon: '0', lat: '0' }).address;
  point.geometry.coordinates = [Number.NaN, 0];
  assert.throws(() => buildSituationQuery(point, null, 'particulier', 'AEP'), /Invalid point/);
});
