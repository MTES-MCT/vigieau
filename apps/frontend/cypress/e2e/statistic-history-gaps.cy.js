/* global cy, describe, it, expect, beforeEach */

import { csv2json } from 'json-2-csv';

const dates = [
  ...Array.from({ length: 10 }, (_, index) => `2026-07-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 8 }, (_, index) => `2026-09-${String(index + 1).padStart(2, '0')}`),
];
const levels = ['vigilance', 'alerte', 'alerte_renforcee', 'crise'];
const areaAmounts = {
  AEP: { vigilance: 10, alerte: 20, alerte_renforcee: 15, crise: 5 },
  ESU: { vigilance: 5, alerte: 15, alerte_renforcee: 10, crise: 10 },
  ESO: { vigilance: 2, alerte: 8, alerte_renforcee: 4, crise: 6 },
};
const departmentLevels = levels.flatMap((level, index) => Array.from({ length: index + 1 }, () => level));
const area = dates.map((date) => ({ date, ...areaAmounts }));
const departments = dates.map((date) => ({
  date,
  departements: departmentLevels.map((level, index) => ({
    code: String(index + 1).padStart(2, '0'),
    niveauGravite: level,
    niveauGraviteAep: level,
    niveauGraviteSup: levels[(levels.indexOf(level) + 1) % levels.length],
    niveauGraviteSou: levels[(levels.indexOf(level) + 2) % levels.length],
  })),
}));
const pages = [
  { path: 'surface', endpoint: 'area', data: area, initialType: 'AEP', nextType: 'ESO' },
  { path: 'departement', endpoint: 'departement', data: departments, initialType: '', nextType: 'SOU' },
];
const warningTitle = 'Données manquantes sur la période';
const gapDescription = 'Du 11/07/2026 au 31/08/2026 : 52 jours sans donnée.';

function typeSelector() {
  return cy.contains('label', "Type d'eau").invoke('attr', 'for').then((id) => cy.get(`[id="${id}"]`));
}

function visitStatistics(page) {
  cy.visit(`/donnees/${page.path}`);
  cy.wait('@statistics');
  cy.get('#dateDebut').clear().type('2026-07-01');
  cy.get('#dateFin').clear().type('2026-09-08');
  cy.contains('button', 'Calculer').click();
  cy.wait('@statistics');
}

function assertGapWarning() {
  cy.contains('[role="status"]', warningTitle).should('be.visible').within(() => {
    cy.get('li').should('have.length', 1).should(($items) => {
      expect($items[0].textContent.trim()).to.equal(gapDescription);
    });
  });
}

function chartForCanvas(canvas) {
  // vue-chartjs exposes its Chart instance; the development server retains the Vue parent.
  let component = canvas.__vueParentComponent;
  while (component) {
    const exposed = component.exposed?.chart;
    const chart = exposed?.value || exposed;
    if (chart?.canvas === canvas) {
      return chart;
    }
    component = component.parent;
  }
  return null;
}

function colorChannels(canvas, color) {
  const sample = canvas.ownerDocument.createElement('canvas');
  sample.width = 1;
  sample.height = 1;
  const context = sample.getContext('2d');
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data];
}

function isColorPixel(pixels, index, colors, minAlpha, maxAlpha) {
  return pixels[index + 3] >= minAlpha
    && pixels[index + 3] <= maxAlpha
    && colors.some((color) => color.slice(0, 3).every((channel, offset) => Math.abs(channel - pixels[index + offset]) <= 12));
}

function countColorPixels(chart, rectangle, colors, minAlpha = 1, maxAlpha = 255) {
  const ratio = chart.currentDevicePixelRatio;
  const left = Math.max(0, Math.floor(rectangle.x * ratio));
  const top = Math.max(0, Math.floor(rectangle.y * ratio));
  const width = Math.min(chart.canvas.width - left, Math.max(1, Math.ceil(rectangle.width * ratio)));
  const height = Math.min(chart.canvas.height - top, Math.max(1, Math.ceil(rectangle.height * ratio)));
  const pixels = chart.ctx.getImageData(left, top, width, height).data;
  let matches = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (isColorPixel(pixels, index, colors, minAlpha, maxAlpha)) {
      matches += 1;
    }
  }
  return matches;
}

function assertRenderedCanvasGap(canvas) {
  // The compiled app does not expose Vue internals. Locate the plot by its severity colors.
  const colors = ['#FFEDA0', '#FEB24C', '#FC4E2A', '#B10026'].map((color) => colorChannels(canvas, color));
  const ratio = canvas.width / canvas.getBoundingClientRect().width;
  const context = canvas.getContext('2d');
  const plotHeight = Math.floor(canvas.height - 100 * ratio);
  const pixels = context.getImageData(0, 0, canvas.width, plotHeight).data;
  let minX = canvas.width;
  let maxX = 0;
  let minY = plotHeight;
  let maxY = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (!isColorPixel(pixels, index, colors, 30, 255)) {
      continue;
    }
    const x = (index / 4) % canvas.width;
    const y = Math.floor(index / 4 / canvas.width);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  expect(maxX - minX, 'deux periodes de donnees rendues hors legende').to.be.greaterThan(canvas.width / 2);
  expect(maxY - minY, 'surface du graphique non vide').to.be.greaterThan(20 * ratio);
  const raster = { canvas, ctx: context, currentDevicePixelRatio: ratio };
  const interval = Date.parse(dates.at(-1)) - Date.parse(dates[0]);
  for (const sample of [
    { date: '2026-07-05T12:00:00Z', present: true },
    { date: '2026-09-04T12:00:00Z', present: true },
    { date: '2026-08-06T12:00:00Z', present: false },
  ]) {
    const fraction = (Date.parse(sample.date) - Date.parse(dates[0])) / interval;
    const rectangle = {
      x: (minX + (maxX - minX) * fraction) / ratio - 1,
      y: minY / ratio,
      width: 2,
      height: (maxY - minY + 1) / ratio,
    };
    const borders = countColorPixels(raster, rectangle, colors, 200);
    const fills = countColorPixels(raster, rectangle, colors, 30, 199);
    if (sample.present) {
      expect(borders, `contour visible entre jours consecutifs (${sample.date})`).to.be.greaterThan(0);
      expect(fills, `remplissage visible entre jours consecutifs (${sample.date})`).to.be.greaterThan(0);
    } else {
      expect(borders, 'aucun contour au milieu des jours absents').to.equal(0);
      expect(fills, 'aucun remplissage au milieu des jours absents').to.equal(0);
    }
  }
}

function assertChartGap() {
  cy.get('main canvas').should('be.visible');
  cy.tick(1500);
  cy.get('main canvas').should('be.visible').should(($canvas) => {
    const canvas = $canvas[0];
    const chart = chartForCanvas(canvas);
    if (!chart) {
      assertRenderedCanvasGap(canvas);
      return;
    }
    chart.stop();
    chart.update('none');
    expect(chart.width, 'largeur du graphique apres redimensionnement').to.be.closeTo(canvas.getBoundingClientRect().width, 2);
    expect(chart.data.labels, 'uniquement les observations recues').to.deep.equal(dates);
    const borderColors = chart.data.datasets.map((dataset) => colorChannels(canvas, dataset.borderColor));
    const fillColors = chart.data.datasets.map((dataset) => colorChannels(canvas, dataset.backgroundColor));
    const gapX = chart.scales.x.getPixelForValue(Date.parse('2026-08-06T12:00:00Z'));
    const gapRectangle = {
      x: gapX - 3,
      y: chart.chartArea.top + 5,
      width: 6,
      height: chart.chartArea.bottom - chart.chartArea.top - 10,
    };
    expect(countColorPixels(chart, gapRectangle, borderColors, 200), 'aucun contour au milieu des jours absents').to.equal(0);
    expect(countColorPixels(chart, gapRectangle, fillColors, 30, 199), 'aucun remplissage au milieu des jours absents').to.equal(0);

    for (const date of ['2026-07-05T12:00:00Z', '2026-09-04T12:00:00Z']) {
      const x = chart.scales.x.getPixelForValue(Date.parse(date));
      const upperY = chart.getDatasetMeta(3).data[0].y;
      const lowerY = chart.getDatasetMeta(2).data[0].y;
      const lineRectangle = { x: x - 1, y: upperY - 2, width: 2, height: 4 };
      const fillRectangle = { x: x - 1, y: (upperY + lowerY) / 2 - 2, width: 2, height: 4 };
      expect(countColorPixels(chart, lineRectangle, [borderColors[3]], 200), `contour present entre jours consecutifs (${date})`).to.be.greaterThan(0);
      expect(countColorPixels(chart, fillRectangle, [fillColors[3]], 30, 199), `remplissage present entre jours consecutifs (${date})`).to.be.greaterThan(0);
    }
  });
}

function expectedCsvRows(page, type) {
  return [...page.data].reverse().map((row) => {
    const values = page.path === 'surface'
      ? row[type]
      : Object.fromEntries(levels.map((level) => [
        level,
        row.departements.filter((department) => department[type === 'SOU' ? 'niveauGraviteSou' : 'niveauGravite'] === level).length,
      ]));
    return { date: row.date, ...values };
  });
}

function assertRawTableAndCsv(page, type, viewportName) {
  cy.get('main select[id$="-results-per-page"]').select('25');
  cy.get('main table tbody tr').should('have.length', dates.length).then(($rows) => {
    const renderedDates = [...$rows].map((row) => row.querySelector('td').textContent.trim());
    const expectedDates = [...dates].reverse().map((date) => date.split('-').reverse().join('/'));
    expect(renderedDates, 'aucune ligne ajoutee pour les jours absents').to.deep.equal(expectedDates);
  });
  cy.get('main table caption').scrollIntoView().should('be.visible');
  cy.document().should((document) => {
    expect(document.documentElement.scrollWidth, 'aucun debordement du document apres affichage du tableau').to.be.at.most(document.documentElement.clientWidth);
  });
  cy.screenshot(`statistics-history-table-${page.path}-${viewportName}`, { capture: 'viewport' });
  let csvBlob;
  cy.window().then((window) => {
    const createObjectURL = window.URL.createObjectURL.bind(window.URL);
    cy.stub(window.URL, 'createObjectURL').callsFake((blob) => {
      csvBlob = blob;
      return createObjectURL(blob);
    }).as('csvUrl');
    cy.stub(window.HTMLAnchorElement.prototype, 'click');
  });
  cy.contains('button', 'CSV').should('not.be.disabled').click();
  cy.get('@csvUrl').should('have.been.calledOnce');
  cy.then(() => csvBlob.text()).then((content) => csv2json(content)).then((rows) => {
    expect(rows, 'CSV conserve les dates et valeurs API sans interpolation').to.deep.equal(expectedCsvRows(page, type));
  });
}

describe('Trous dans les historiques statistiques publics', () => {
  beforeEach(() => {
    cy.clock(Date.UTC(2026, 8, 8, 12), ['Date']);
    cy.intercept('GET', '**/data', { body: { departements: [], regions: [], bassinsVersants: [] } });
    cy.intercept('GET', '**/data/status', { body: { status: 'ready', usable: true, currentFresh: true } });
    cy.intercept('GET', '**/zones/publication', { statusCode: 503, body: {} });
  });

  for (const page of pages) {
    for (const viewport of [
      { name: 'desktop', width: 1280, height: 900 },
      { name: 'mobile', width: 375, height: 812 },
    ]) {
      it(`${page.path} ${viewport.name}: coupe contours et remplissages sans inventer de donnees`, () => {
        cy.viewport(viewport.width, viewport.height);
        cy.intercept('GET', `**/data/${page.endpoint}?*`, { body: page.data }).as('statistics');
        visitStatistics(page);
        assertGapWarning();
        typeSelector().should('have.value', page.initialType);
        assertChartGap();
        typeSelector().select(page.nextType);
        assertGapWarning();
        assertChartGap();
        cy.document().should((document) => {
          expect(document.documentElement.scrollWidth, 'aucun debordement horizontal').to.be.at.most(document.documentElement.clientWidth);
        });
        cy.get('main canvas').scrollIntoView();
        cy.screenshot(`statistics-history-gap-${page.path}-${viewport.name}`, { capture: 'viewport' });
        assertRawTableAndCsv(page, page.nextType, viewport.name);
      });
    }

    it(`${page.path}: rattache l'avertissement aux donnees chargees puis le retire apres recalcul`, () => {
      let continuous = false;
      cy.intercept('GET', `**/data/${page.endpoint}?*`, (request) => {
        request.reply({ body: continuous ? page.data.filter((row) => row.date >= '2026-09-01') : page.data });
      }).as('statistics');
      visitStatistics(page);
      assertGapWarning();
      cy.get('#dateDebut').clear().type('2026-09-01');
      assertGapWarning();
      cy.contains('button', 'CSV').should('be.disabled');
      cy.then(() => { continuous = true; });
      cy.contains('button', 'Calculer').click();
      cy.wait('@statistics');
      cy.contains(warningTitle).should('not.exist');
      cy.get('main canvas').should('be.visible');
      cy.get('main table tbody tr').should('have.length', 8);
      cy.contains('button', 'CSV').should('not.be.disabled');
    });
  }
});
