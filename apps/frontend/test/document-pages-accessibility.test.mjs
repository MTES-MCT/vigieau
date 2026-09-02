import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { NodeTypes } from '@vue/compiler-dom';
import { parse } from '@vue/compiler-sfc';
import { JSDOM } from 'jsdom';

const sourceUrls = {
  accessibility: new URL('../client/pages/accessibilite/index.vue', import.meta.url),
  personalData: new URL('../client/pages/donnees-personnelles/index.vue', import.meta.url),
  legalNotice: new URL('../client/pages/mentions-legales/index.vue', import.meta.url),
  documentNotice: new URL('../client/components/DocumentAccessibilityNotice.vue', import.meta.url),
  restrictionOrders: new URL('../client/components/donnees/ArretesRestrictionsTable.vue', import.meta.url),
  situationStatus: new URL('../client/components/situation/Status.vue', import.meta.url),
};

const sources = Object.fromEntries(
  await Promise.all(
    Object.entries(sourceUrls).map(async ([name, url]) => [
      name,
      await readFile(url, 'utf8'),
    ]),
  ),
);
const faqSource = await readFile(
  new URL('../client/data/faq.json', import.meta.url),
  'utf8',
);
const faq = JSON.parse(faqSource);

function templateElements(name, source) {
  const { descriptor, errors } = parse(source, { filename: `${name}.vue` });

  assert.deepEqual(errors, [], `${name}: erreurs de syntaxe Vue`);
  assert.ok(descriptor.template?.ast, `${name}: template absent`);

  const elements = [];
  const visit = (node, ancestors = []) => {
    const nextAncestors = node.type === NodeTypes.ELEMENT
      ? [...ancestors, node]
      : ancestors;

    if (node.type === NodeTypes.ELEMENT) {
      elements.push({ node, ancestors });
    }
    for (const child of node.children ?? []) {
      visit(child, nextAncestors);
    }
  };

  visit(descriptor.template.ast);
  return elements;
}

function hasMeaningfulContent(node) {
  return (node.children ?? []).some((child) => {
    if (child.type === NodeTypes.TEXT) {
      return child.content.trim() !== '';
    }
    if (child.type === NodeTypes.COMMENT) {
      return false;
    }
    if (child.type === NodeTypes.ELEMENT && child.tag === 'br') {
      return false;
    }
    return true;
  });
}

test('uses an actionable document alternative notice on situation and data pages', () => {
  assert.match(
    sources.documentNotice,
    /<p\b[\s\S]*?<NuxtLink[\s\S]*?to="\/accessibilite#amelioration-contact"/,
  );
  assert.match(sources.documentNotice, /contactez l’équipe VigiEau/);
  assert.match(sources.documentNotice, /orienté vers une alternative/);
  assert.match(sources.accessibility, /id="amelioration-contact"/);
  assert.match(sources.accessibility, /responsable de VigiEau/);

  assert.match(
    sources.situationStatus,
    /zone\?\.arreteMunicipalCheminFichier[\s\S]*?<DocumentAccessibilityNotice\s*\/>/,
  );
  assert.match(
    sources.restrictionOrders,
    /<AccessibleDataTable[\s\S]*?<DocumentAccessibilityNotice\s*\/>/,
  );
});

test('replaces obsolete FAQ documents with named official HTML sources', () => {
  assert.doesNotMatch(faqSource, /\.pdf(?:[?"'\\]|$)/i);
  assert.doesNotMatch(
    faqSource,
    /Guide%20circulaire|MM23087|ste_20170009_0000_0109|sites\/default\/files|sante\.gouv\.fr\/fichiers\/bo/i,
  );

  const documents = faq.categories.flatMap(category =>
    category.data.map(({ question, response }) => ({
      question,
      document: new JSDOM(`<body>${response}</body>`).window.document,
    })),
  );
  const findAnswer = questionStart => {
    const answer = documents.find(({ question }) =>
      question.startsWith(questionStart),
    );

    assert.ok(answer, `Question introuvable : ${questionStart}`);
    return answer.document;
  };

  const restrictionsUrl = 'https://www.ecologie.gouv.fr/politiques-publiques/origine-gestion-secheresse';
  const orsecUrl = 'https://www.legifrance.gouv.fr/circulaire/id/42547';
  const restrictionsLink = findAnswer('Puis-je arroser mon jardin')
    .querySelector(`a[href="${restrictionsUrl}"]`);
  assert.ok(restrictionsLink);
  assert.match(restrictionsLink.textContent, /page officielle.*mesures de restriction/i);

  for (const questionStart of [
    'En cas de sécheresse, est-ce que les hôpitaux',
    'Comment serai-je approvisionné en eau potable',
  ]) {
    const link = findAnswer(questionStart).querySelector(`a[href="${orsecUrl}"]`);
    assert.ok(link, questionStart);
    assert.match(
      link.textContent,
      /fiche officielle de l’instruction ORSEC Eau potable sur Légifrance/,
    );
  }

  for (const href of [restrictionsUrl, orsecUrl]) {
    const url = new URL(href);
    assert.equal(url.protocol, 'https:');
    assert.doesNotMatch(url.pathname, /\.pdf$/i);
  }
});

test('keeps institutional paragraphs, lists and tables structurally valid', () => {
  const institutionalSources = {
    accessibility: sources.accessibility,
    personalData: sources.personalData,
    legalNotice: sources.legalNotice,
  };

  for (const [name, source] of Object.entries(institutionalSources)) {
    const elements = templateElements(name, source);

    for (const { node: paragraph } of elements.filter(({ node }) => node.tag === 'p')) {
      assert.equal(hasMeaningfulContent(paragraph), true, `${name}: paragraphe vide`);
      const invalidDescendants = elements.filter(({ node, ancestors }) =>
        ancestors.includes(paragraph)
        && ['div', 'ol', 'table', 'ul'].includes(node.tag),
      );
      assert.deepEqual(
        invalidDescendants.map(({ node }) => node.tag),
        [],
        `${name}: contenu de bloc imbriqué dans un paragraphe`,
      );
    }

    for (const { node: list } of elements.filter(({ node }) =>
      node.tag === 'ul' || node.tag === 'ol')) {
      const directElementChildren = list.children.filter(
        child => child.type === NodeTypes.ELEMENT,
      );
      assert.ok(directElementChildren.length > 0, `${name}: liste vide`);
      assert.equal(
        directElementChildren.every(child => child.tag === 'li'),
        true,
        `${name}: enfant direct de liste invalide`,
      );
    }

    for (const { node: table, ancestors } of elements.filter(({ node }) =>
      node.tag === 'table')) {
      assert.equal(
        ancestors.some(ancestor => ancestor.tag === 'p'),
        false,
        `${name}: tableau imbriqué dans un paragraphe`,
      );
      const tableElements = elements.filter(({ ancestors: candidates }) =>
        candidates.includes(table),
      );
      assert.equal(tableElements.filter(({ node }) => node.tag === 'caption').length, 1);
      assert.equal(tableElements.filter(({ node }) => node.tag === 'thead').length, 1);
      assert.equal(tableElements.filter(({ node }) => node.tag === 'tbody').length, 1);

      for (const { node: row } of tableElements.filter(({ node }) => node.tag === 'tr')) {
        const cells = row.children.filter(child => child.type === NodeTypes.ELEMENT);
        assert.ok(cells.length > 0, `${name}: ligne de tableau vide`);
        assert.equal(
          cells.every(cell => cell.tag === 'td' || cell.tag === 'th'),
          true,
          `${name}: cellule de tableau invalide`,
        );
      }
    }
  }

  const personalDataTables = templateElements(
    'personalData',
    sources.personalData,
  ).filter(({ node }) => node.tag === 'table');
  assert.equal(personalDataTables.length, 2);
});

test('preserves the corrected institutional labels', () => {
  assert.doesNotMatch(
    sources.accessibility,
    /Parmis|responsable de Potentiel|a été créé le|Cohésion des territoires/,
  );
  assert.match(sources.accessibility, /Parmi les points bloquants/);
  assert.match(sources.accessibility, /#plan-2026/);
  assert.match(sources.accessibility, /a été créée le/);
  assert.match(
    sources.accessibility,
    /Ministère de la Transition écologique, de la Biodiversité et des Négociations internationales/,
  );
  assert.match(
    sources.accessibility,
    /constats ci-dessous sont ceux de l’audit de janvier 2025/,
  );

  assert.doesNotMatch(
    sources.personalData,
    /RPGD|identité\.\}|se désinscrit de|l’accès physiques/,
  );
  assert.match(sources.personalData, /article 6-1 e\) du RGPD/);
  assert.match(sources.personalData, /se désinscrive de/);
  assert.match(sources.personalData, /l’accès physique aux données/);
  assert.match(sources.personalData, /<caption>Durée de conservation des données personnelles<\/caption>/);
  assert.match(sources.personalData, /<caption>Sous-traitants de données<\/caption>/);

  assert.doesNotMatch(
    sources.legalNotice,
    /Cohésion des territoires|Négociations\s+internationales|par intérim|newsletter est géré(?:\s|<)/,
  );
  assert.match(
    sources.legalNotice,
    /Ministères\s+Transition écologique, Aménagement du Territoire, Transports, Ville et\s+Logement/,
  );
  assert.match(sources.legalNotice, /directeur général de/);
  assert.match(sources.legalNotice, /newsletter est gérée/);
});
