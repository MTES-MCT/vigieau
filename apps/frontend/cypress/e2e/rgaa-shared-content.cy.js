/* global cy, describe, expect, it */

const publicRoutes = [
  '/',
  '/accessibilite',
  '/mentions-legales',
  '/cookies',
  '/donnees-personnelles',
  '/donnees',
  '/emails',
  '/emails/smgc',
];

const normalizeText = (value) => value
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

function getAccessibleLabel(link) {
  const ariaLabel = link.getAttribute('aria-label');
  if (ariaLabel) {
    return ariaLabel;
  }

  const labelledBy = link.getAttribute('aria-labelledby');
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => link.ownerDocument.getElementById(id)?.textContent || '')
      .join(' ');
  }

  return link.textContent || '';
}

describe('Contenus partagés accessibles', () => {
  for (const route of publicRoutes) {
    it(`annonce les nouvelles fenêtres et expose les images sur ${route}`, () => {
      cy.visit(route);

      cy.get('a[target="_blank"]').should(($links) => {
        expect($links.length).to.be.greaterThan(0);

        for (const link of $links) {
          const relTokens = new Set(
            (link.getAttribute('rel') || '').toLowerCase().split(/\s+/),
          );
          expect(relTokens.has('noopener')).to.equal(true);
          expect(relTokens.has('noreferrer')).to.equal(true);
          expect(relTokens.has('opener')).to.equal(false);

          const label = normalizeText(getAccessibleLabel(link));
          expect(label).to.include('nouvelle fenetre');

          const suffixes = link.querySelectorAll(
            '[data-vigieau-new-window-suffix]',
          );
          expect(suffixes.length).to.be.at.most(1);
        }
      });

      cy.get('img').each(($image) => {
        expect($image[0].hasAttribute('alt')).to.equal(true);
        expect(
          ($image[0].getAttribute('title') || '').trim(),
          `${route}: ${$image[0].getAttribute('src')} ne doit pas avoir de title pertinent ou redondant`,
        ).to.equal('');
      });
    });
  }
});
