import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { compile, parse as parseTemplate } from '@vue/compiler-dom';
import { parse } from '@vue/compiler-sfc';
import { renderToString } from '@vue/server-renderer';
import * as Vue from 'vue';

function findLink(node) {
  if (node.tag === 'NuxtLink') return node;
  for (const child of node.children || []) {
    const link = findLink(child);
    if (link) return link;
  }
}

for (const [kind, property] of [
  ['arreteCadre', 'arreteCadre'],
  ['arreteRestriction', 'arreteRestriction'],
]) {
  test(`${kind} card keeps the destination and formatted number inside its router link`, async () => {
    const source = await readFile(new URL(`../client/components/${kind}/card.vue`, import.meta.url), 'utf8');
    const template = parse(source).descriptor.template.content;
    const link = findLink(parseTemplate(template));
    const { code } = compile(link.loc.source, {
      mode: 'function',
      prefixIdentifiers: true,
    });
    const render = runInNewContext(`(() => { ${code} })()`, { Vue });
    const app = Vue.createSSRApp({
      data: () => ({
        [property]: { id: 42, statut: 'a_valider' },
        canUpdate: true,
        numeroToDisplay: '<strong>2026-42</strong>',
      }),
      render,
    });
    app.component('NuxtLink', {
      props: ['to'],
      setup:
        (props, { slots }) =>
        () =>
          Vue.h('a', { href: props.to }, slots.default()),
    });
    const html = await renderToString(app);
    const route = kind === 'arreteCadre' ? 'arrete-cadre' : 'arrete-restriction';
    assert.match(html, new RegExp(`href="/${route}/42/edition"`));
    assert.match(html, /<span><strong>2026-42<\/strong><\/span>/);
  });
}
