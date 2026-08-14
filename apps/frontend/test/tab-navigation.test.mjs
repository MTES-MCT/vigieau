import assert from 'node:assert/strict';
import test from 'node:test';
import { getHorizontalTabIndex } from '../client/utils/tab-navigation.ts';

test('les flèches parcourent les onglets horizontalement avec rebouclage', () => {
  assert.equal(getHorizontalTabIndex(0, 2, 'ArrowRight'), 1);
  assert.equal(getHorizontalTabIndex(1, 2, 'ArrowRight'), 0);
  assert.equal(getHorizontalTabIndex(1, 2, 'ArrowLeft'), 0);
  assert.equal(getHorizontalTabIndex(0, 2, 'ArrowLeft'), 1);
});

test('Début et Fin ciblent les extrémités du jeu d’onglets', () => {
  assert.equal(getHorizontalTabIndex(1, 3, 'Home'), 0);
  assert.equal(getHorizontalTabIndex(0, 3, 'End'), 2);
});

test('les autres touches et les jeux vides ne changent pas d’onglet', () => {
  assert.equal(getHorizontalTabIndex(0, 2, 'Tab'), null);
  assert.equal(getHorizontalTabIndex(0, 0, 'ArrowRight'), null);
});
