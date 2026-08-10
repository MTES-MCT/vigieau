import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const clientRoot = fileURLToPath(new URL('../client/', import.meta.url));

const collectVueFiles = (directory) => readdirSync(directory, {
  withFileTypes: true,
}).flatMap((entry) => {
  const entryPath = path.join(directory, entry.name);

  if (entry.isDirectory()) {
    return collectVueFiles(entryPath);
  }

  return entry.isFile() && entry.name.endsWith('.vue') ? [entryPath] : [];
});

const sources = collectVueFiles(clientRoot).map((filePath) => ({
  filePath,
  source: readFileSync(filePath, 'utf8'),
}));

const openingTags = (source, tagName) => source.match(
  new RegExp(`<${tagName}\\b[^>]*>`, 'g'),
) ?? [];

const hasAttribute = (tag, attribute) => new RegExp(
  `\\s(?::)?${attribute}\\s*=`,
  'i',
).test(tag);

test('every native public image has an explicit alternative and no title', () => {
  const images = sources.flatMap(({ filePath, source }) => openingTags(
    source,
    'img',
  ).map((tag) => ({ filePath, tag })));

  assert.ok(images.length > 0);
  for (const { filePath, tag } of images) {
    assert.equal(
      hasAttribute(tag, 'alt'),
      true,
      `missing alt in ${path.relative(clientRoot, filePath)}: ${tag}`,
    );
    assert.equal(
      hasAttribute(tag, 'title'),
      false,
      `redundant title in ${path.relative(clientRoot, filePath)}: ${tag}`,
    );
  }
});

test('decorative public illustrations stay ignored by assistive technologies', () => {
  const decorativeSources = [
    '/accueil_donnees.svg',
    '/callout_simulateur.svg',
    '/emails_popcorn.png',
    '/newsletter_img.png',
  ];
  const imageTags = sources.flatMap(({ source }) => openingTags(source, 'img'));

  for (const imageSource of decorativeSources) {
    const matchingImages = imageTags.filter((tag) => tag.includes(
      `src="${imageSource}"`,
    ));

    assert.ok(matchingImages.length > 0, `missing image ${imageSource}`);
    for (const tag of matchingImages) {
      assert.match(tag, /\salt=""/);
    }
  }
});

test('informative public images keep a meaningful alternative', () => {
  const mapSource = readFileSync(
    path.join(clientRoot, 'components/accueil/Carte.vue'),
    'utf8',
  );
  const mapImages = openingTags(mapSource, 'img');

  assert.equal(mapImages.length, 2);
  for (const tag of mapImages) {
    assert.match(tag, /Carte des niveaux de gravité de la sécheresse/);
  }

  const gesturesSource = readFileSync(
    path.join(clientRoot, 'components/accueil/Gestes.vue'),
    'utf8',
  );
  const [consumptionPicture] = openingTags(gesturesSource, 'DsfrPicture');

  for (const expectedText of [
    '39% - Se laver',
    '20% - Aller au WC',
    '1% - Boire',
    'Source : Ademe',
  ]) {
    assert.ok(consumptionPicture.includes(expectedText));
  }
  assert.equal(hasAttribute(consumptionPicture, 'title'), false);
});

test('DSFR image props always provide an alternative', () => {
  for (const { filePath, source } of sources) {
    for (const tag of openingTags(source, 'DsfrPicture')) {
      assert.equal(
        hasAttribute(tag, 'alt'),
        true,
        `missing alt in ${path.relative(clientRoot, filePath)}: ${tag}`,
      );
    }

    for (const tag of openingTags(source, 'DsfrCard')) {
      if (!hasAttribute(tag, 'img-src')) {
        continue;
      }

      assert.equal(
        hasAttribute(tag, 'alt-img'),
        true,
        `missing alt-img in ${path.relative(clientRoot, filePath)}: ${tag}`,
      );
    }

    for (const component of ['DsfrHeader', 'DsfrFooter']) {
      for (const tag of openingTags(source, component)) {
        const hasOperatorImageSource = tag.includes(':operator-img-src=')
          || tag.includes(':operatorImgSrc=');

        if (!hasOperatorImageSource) {
          continue;
        }

        const hasOperatorImageAlt = tag.includes(':operator-img-alt=')
          || tag.includes(':operatorImgAlt=');

        assert.equal(
          hasOperatorImageAlt,
          true,
          `missing operator image alt in ${path.relative(clientRoot, filePath)}: ${tag}`,
        );
      }
    }
  }
});

test('partner logo alternatives name the organizations without saying logo', () => {
  const expectedAlternatives = new Map([
    ['layouts/emails/chambery.vue', 'Grand Chambéry'],
    ['layouts/emails/smgc.vue', 'SMGC et Veolia'],
  ]);

  for (const [relativePath, expectedAlternative] of expectedAlternatives) {
    const source = readFileSync(path.join(clientRoot, relativePath), 'utf8');

    assert.ok(source.includes(`const operatorImgAlt: string = '${expectedAlternative}'`));
    assert.doesNotMatch(source, /operatorImgAlt[^=]*=\s*['"`]Logo\b/i);
  }
});
