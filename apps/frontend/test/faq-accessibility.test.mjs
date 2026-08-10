import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { parseFragment } from 'parse5';

const faq = JSON.parse(
  await readFile(
    new URL('../client/data/faq.json', import.meta.url),
    'utf8',
  ),
);
const faqSource = await readFile(
  new URL('../client/components/accueil/Faq.vue', import.meta.url),
  'utf8',
);
const questions = faq.categories.flatMap((category) => category.data);

const findAnswer = (questionStart) => {
  const item = questions.find(({ question }) =>
    question.startsWith(questionStart),
  );

  assert.ok(item, `Question introuvable : ${questionStart}`);
  return new JSDOM(`<body>${item.response}</body>`).window.document;
};

test('conserve un groupe unique et la hiérarchie h3/h4', () => {
  assert.match(
    faqSource,
    /const activeAccordion = ref<number>\(\);/,
  );
  assert.match(
    faqSource,
    /<DsfrAccordionsGroup v-model="activeAccordion">/,
  );
  assert.equal(
    faqSource.match(/<DsfrAccordionsGroup\b/g)?.length,
    1,
  );
  assert.match(
    faqSource,
    /v-for="\(category, x\) in faq\.categories"[\s\S]*?<h3[\s\S]*?\{\{ category\.name \}\}/,
  );
  assert.match(faqSource, /titleTag="h4"/);
});

test('conserve des fragments HTML et des listes bien formés', () => {
  for (const { question, response } of questions) {
    assert.doesNotMatch(response, /&nbps;|•/u, question);

    const parsingErrors = [];
    parseFragment(response, {
      onParseError: (error) => parsingErrors.push(error.code),
    });
    assert.deepEqual(parsingErrors, [], question);

    const namedEntities = [...response.matchAll(/&([a-z][a-z0-9]+);/gi)]
      .map((match) => match[1]);
    assert.deepEqual(
      [...new Set(namedEntities)].sort(),
      namedEntities.length > 0 ? ['nbsp'] : [],
      question,
    );

    const document = new JSDOM(`<body>${response}</body>`).window.document;
    for (const list of document.querySelectorAll('ul, ol')) {
      assert.ok(list.children.length > 0, `${question} : liste vide`);
      assert.ok(
        [...list.children].every((child) => child.tagName === 'LI'),
        `${question} : enfant de liste invalide`,
      );
    }
    for (const item of document.querySelectorAll('li')) {
      assert.match(item.parentElement?.tagName || '', /^(UL|OL)$/, question);
    }
  }
});

test('structure les trois causes de sécheresse en liste non ordonnée', () => {
  const document = findAnswer('Quelles sont les causes des sécheresses');
  const causes = document.querySelectorAll('ul > li');

  assert.equal(causes.length, 3);
  assert.match(causes[0].textContent, /sécheresse météorologique/);
  assert.match(causes[1].textContent, /sécheresse agricole/);
  assert.match(causes[2].textContent, /sécheresse hydrologique/);
  assert.equal(document.querySelectorAll('body > p').length, 3);
});

test('préserve les niveaux ordonnés et masque les flèches du Plan Eau', () => {
  const levels = findAnswer('Quels sont les différents niveaux d’alerte');
  assert.equal(levels.querySelectorAll('ol > li').length, 4);

  const plan = findAnswer('Comment le Gouvernement se mobilise-t-il');
  assert.equal(plan.querySelectorAll('ul > li').length, 3);
  const arrows = plan.querySelectorAll('span[aria-hidden="true"]');
  assert.equal(arrows.length, 3);
  for (const arrow of arrows) {
    assert.equal(arrow.textContent.trim(), '→');
  }
});

test('structure les solutions de substitution et préserve le lien ORSEC', () => {
  const document = findAnswer('Comment serai-je approvisionné en eau potable');
  const solutions = document.querySelectorAll('ul > li');

  assert.equal(solutions.length, 3);
  assert.match(solutions[0].textContent, /eau embouteillée ou ensachée/);
  assert.match(solutions[1].textContent, /unités mobiles de traitement/);
  assert.match(solutions[2].textContent, /camions citernes/);
  assert.equal(document.querySelectorAll('body > p').length, 3);

  const link = document.querySelector('a[href*="ste_20170009_0000_0109.pdf"]');
  assert.ok(link);
  assert.equal(link.getAttribute('target'), '_blank');
  assert.match(link.textContent, /instruction interministérielle ORSEC/);
});
