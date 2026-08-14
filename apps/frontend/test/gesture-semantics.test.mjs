import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const homeGesturesSource = await readFile(
  new URL('../client/components/accueil/Gestes.vue', import.meta.url),
  'utf8',
);
const restrictionSource = await readFile(
  new URL('../client/components/situation/Restrictions.vue', import.meta.url),
  'utf8',
);
const gestureCardSource = await readFile(
  new URL('../client/components/gestes/Card.vue', import.meta.url),
  'utf8',
);

test('uses pressed filter buttons instead of orphan tab panels', () => {
  for (const source of [homeGesturesSource, restrictionSource]) {
    assert.doesNotMatch(source, /<DsfrTabs\b|<DsfrTabContent\b/);
    assert.doesNotMatch(source, /\brole=""/);
    assert.match(source, /:aria-pressed="selectedTagIndex === index"/);
    assert.match(source, /role="region"/);
    assert.match(source, /:aria-labelledby=/);
  }

  assert.match(
    homeGesturesSource,
    /id="home-gestures-results"[\s\S]*?:aria-labelledby="selectedTagButtonId"/,
  );
  assert.match(
    restrictionSource,
    /id="restriction-theme-results"[\s\S]*?:aria-labelledby="selectedThematiqueButtonId"/,
  );
  assert.match(
    restrictionSource,
    /role="group"[\s\S]*?aria-label="Filtrer les restrictions par type d’usage"/,
  );
});

test('keeps every eco-gesture as one list item and one coherent paragraph', () => {
  assert.match(
    homeGesturesSource,
    /<ul[\s\S]*?class="gestures-list[\s\S]*?role="list"[\s\S]*?<GestesCard[\s\S]*?<\/ul>/,
  );
  assert.match(gestureCardSource, /<li\b[\s\S]*?<p\b[\s\S]*?<\/p>[\s\S]*?<\/li>/);
  assert.match(
    gestureCardSource,
    /geste\.title[\s\S]*?geste\.description/,
  );
  assert.doesNotMatch(gestureCardSource, /v-html/);
  assert.match(gestureCardSource, /aria-hidden="true"/);
});

test('resets an obsolete restriction filter when available themes change', () => {
  assert.match(
    restrictionSource,
    /watch\([\s\S]*?thematiqueTagsFiltered[\s\S]*?selectedTagIndex\.value >= themes\.length[\s\S]*?selectedTagIndex\.value = 0/,
  );
});
