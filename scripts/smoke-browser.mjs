import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import {
  buildTarbesSituationExpectations,
  isTarbesZoneLookupUrl,
  parseTarbesCheckMode,
  resolveTarbesLookupOutcome,
} from "./smoke-browser-tarbes.mjs";
import {
  terminateChild,
  waitForChromeDevTools,
} from "./smoke-browser-startup.mjs";

const frontBase = (
  process.env.VIGIEAU_FRONT_URL || "https://vigieau.gouv.fr"
).replace(/\/+$/, "");
const expectedServiceWorkerUrl = new URL("/sw.js", frontBase).href;
const tarbesExpectedModalTitle = "Nous avons besoin de plus de pr\u00e9cision";
const tarbesResourceModalTitle =
  "Pour consulter les restrictions, veuillez s\u00e9lectionner la ressource dans laquelle vous pr\u00e9levez de l\u2019eau.";
const tarbesForbiddenMessage =
  /Pas d['\u2019]arr\u00eat\u00e9 en vigueur|Aucune restriction/i;
const timeoutMs = Number(
  process.env.VIGIEAU_BROWSER_SMOKE_TIMEOUT_MS || 60_000,
);
const chromeStartupTimeoutMs = Math.min(
  Number(process.env.VIGIEAU_CHROME_STARTUP_TIMEOUT_MS || 30_000),
  timeoutMs,
);
const zonePaletteMaxDistance = Number(
  process.env.VIGIEAU_ZONE_PALETTE_MAX_DISTANCE || 24,
);
const minZonePalettePixels = Number(
  process.env.VIGIEAU_MIN_ZONE_PALETTE_PIXELS || 100,
);
const minZonePaletteRatio = Number(
  process.env.VIGIEAU_MIN_ZONE_PALETTE_RATIO || 0.001,
);
const tarbesCheckMode = parseTarbesCheckMode(
  process.env.VIGIEAU_BROWSER_TARBES_MODE,
);

const zonePalette = [
  { name: "vigilance", rgb: [255, 237, 160] },
  { name: "alerte", rgb: [254, 178, 76] },
  { name: "alerte_renforcee", rgb: [252, 78, 42] },
  { name: "crise", rgb: [177, 0, 38] },
];

assert.ok(
  Number.isFinite(timeoutMs) && timeoutMs >= 10_000,
  "VIGIEAU_BROWSER_SMOKE_TIMEOUT_MS must be at least 10000",
);
assert.ok(
  Number.isInteger(chromeStartupTimeoutMs) && chromeStartupTimeoutMs >= 1_000,
  "VIGIEAU_CHROME_STARTUP_TIMEOUT_MS must be at least 1000",
);
assert.ok(
  Number.isFinite(zonePaletteMaxDistance) && zonePaletteMaxDistance >= 0,
  "VIGIEAU_ZONE_PALETTE_MAX_DISTANCE must be a non-negative number",
);
assert.ok(
  Number.isInteger(minZonePalettePixels) && minZonePalettePixels >= 1,
  "VIGIEAU_MIN_ZONE_PALETTE_PIXELS must be a positive integer",
);
assert.ok(
  Number.isFinite(minZonePaletteRatio) &&
    minZonePaletteRatio > 0 &&
    minZonePaletteRatio < 1,
  "VIGIEAU_MIN_ZONE_PALETTE_RATIO must be between 0 and 1",
);
async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/bin/google-chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next standard installation path.
    }
  }
  throw new Error("No Chrome or Chromium executable was found");
}

class DevToolsClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener(
        "error",
        () => reject(new Error("Unable to connect to Chrome DevTools")),
        { once: true },
      );
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) {
          pending.reject(
            new Error(`${pending.method}: ${message.error.message}`),
          );
        } else {
          pending.resolve(message.result || {});
        }
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 15_000);
      this.pending.set(id, { method, resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ||
          response.exceptionDetails.text ||
          "Browser evaluation failed",
      );
    }
    return response.result?.value;
  }

  close() {
    this.socket?.close();
  }
}

async function waitFor(check, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `${description} did not become ready${lastError ? `: ${lastError.message}` : ""}`,
  );
}

function decodePng(png) {
  assert.equal(
    png.subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
    "Chrome returned an invalid PNG screenshot",
  );
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  const imageData = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      imageData.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }
  assert.ok(
    width > 0 && height > 0,
    "The map screenshot has invalid dimensions",
  );
  assert.equal(bitDepth, 8, "Unsupported PNG bit depth");
  assert.equal(interlace, 0, "Unsupported interlaced PNG screenshot");
  assert.ok(
    [2, 6].includes(colorType),
    `Unsupported PNG color type ${colorType}`,
  );

  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(imageData));
  assert.equal(
    inflated.length,
    height * (stride + 1),
    "The map screenshot payload is truncated",
  );
  const pixels = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const estimate = a + b - c;
    const distanceA = Math.abs(estimate - a);
    const distanceB = Math.abs(estimate - b);
    const distanceC = Math.abs(estimate - c);
    if (distanceA <= distanceB && distanceA <= distanceC) return a;
    return distanceB <= distanceC ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const sourceOffset = y * (stride + 1);
    const filter = inflated[sourceOffset];
    for (let x = 0; x < stride; x++) {
      const raw = inflated[sourceOffset + 1 + x];
      const targetOffset = y * stride + x;
      const left =
        x >= bytesPerPixel ? pixels[targetOffset - bytesPerPixel] : 0;
      const above = y > 0 ? pixels[targetOffset - stride] : 0;
      const upperLeft =
        y > 0 && x >= bytesPerPixel
          ? pixels[targetOffset - stride - bytesPerPixel]
          : 0;
      if (filter === 0) pixels[targetOffset] = raw;
      else if (filter === 1) pixels[targetOffset] = (raw + left) & 255;
      else if (filter === 2) pixels[targetOffset] = (raw + above) & 255;
      else if (filter === 3) {
        pixels[targetOffset] = (raw + Math.floor((left + above) / 2)) & 255;
      } else if (filter === 4) {
        pixels[targetOffset] = (raw + paeth(left, above, upperLeft)) & 255;
      } else {
        throw new Error(`Unsupported PNG filter ${filter}`);
      }
    }
  }
  return { width, height, bytesPerPixel, pixels };
}

function inspectPixels(png) {
  const { width, height, bytesPerPixel, pixels } = decodePng(png);
  const step = Math.max(1, Math.floor(Math.min(width, height) / 180));
  const histogram = new Map();
  let samples = 0;
  let mean = 0;
  let sumSquares = 0;
  let minLuminance = 255;
  let maxLuminance = 0;
  let closestZonePaletteDistance = Number.POSITIVE_INFINITY;
  let zonePalettePixels = 0;
  const zonePaletteCounts = Object.fromEntries(
    zonePalette.map(({ name }) => [name, 0]),
  );
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const offset = (y * width + x) * bytesPerPixel;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      const color = `${red >> 4}:${green >> 4}:${blue >> 4}`;
      histogram.set(color, (histogram.get(color) || 0) + 1);
      samples++;
      const delta = luminance - mean;
      mean += delta / samples;
      sumSquares += delta * (luminance - mean);
      minLuminance = Math.min(minLuminance, luminance);
      maxLuminance = Math.max(maxLuminance, luminance);
      let closestPaletteEntry;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const paletteEntry of zonePalette) {
        const [paletteRed, paletteGreen, paletteBlue] = paletteEntry.rgb;
        const distance = Math.hypot(
          red - paletteRed,
          green - paletteGreen,
          blue - paletteBlue,
        );
        if (distance < closestDistance) {
          closestDistance = distance;
          closestPaletteEntry = paletteEntry;
        }
      }
      closestZonePaletteDistance = Math.min(
        closestZonePaletteDistance,
        closestDistance,
      );
      if (closestDistance <= zonePaletteMaxDistance) {
        zonePalettePixels++;
        zonePaletteCounts[closestPaletteEntry.name]++;
      }
    }
  }
  const dominantCount = Math.max(...histogram.values());
  return {
    width,
    height,
    sampledPixels: samples,
    quantizedColors: histogram.size,
    luminanceRange: Number((maxLuminance - minLuminance).toFixed(2)),
    luminanceStdDev: Number(Math.sqrt(sumSquares / samples).toFixed(2)),
    dominantColorRatio: Number((dominantCount / samples).toFixed(4)),
    closestZonePaletteDistance: Number(closestZonePaletteDistance.toFixed(2)),
    zonePalettePixels,
    zonePaletteRatio: Number((zonePalettePixels / samples).toFixed(4)),
    zonePaletteCounts,
  };
}

const scenarios = [
  {
    name: "desktop",
    width: 1440,
    height: 1000,
    mobile: false,
    requireServiceWorker: false,
  },
  {
    name: "mobile-service-worker",
    width: 390,
    height: 844,
    mobile: true,
    requireServiceWorker: true,
  },
];

const requests = new Map();
const pmtilesResponses = [];
const zoneLookupResponses = [];
const fatalErrors = [];
const serviceWorkerErrors = [];
const serviceWorkerVersions = [];

function resetObservations() {
  requests.clear();
  pmtilesResponses.length = 0;
  zoneLookupResponses.length = 0;
  fatalErrors.length = 0;
  serviceWorkerErrors.length = 0;
  serviceWorkerVersions.length = 0;
}

async function applyViewport(client, scenario) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: scenario.width,
    height: scenario.height,
    deviceScaleFactor: 1,
    mobile: scenario.mobile,
    screenWidth: scenario.width,
    screenHeight: scenario.height,
    screenOrientation: {
      type: "portraitPrimary",
      angle: 0,
    },
  });
  await client.send("Emulation.setTouchEmulationEnabled", {
    enabled: scenario.mobile,
    maxTouchPoints: scenario.mobile ? 5 : 1,
  });
}

async function navigate(client, url) {
  const navigation = await client.send("Page.navigate", { url });
  assert.ok(
    !navigation.errorText,
    `Navigation to ${url} failed: ${navigation.errorText}`,
  );
  return waitFor(async () => {
    const state = await client.evaluate(`(() => ({
      href: location.href,
      readyState: document.readyState,
    }))()`);
    return state?.readyState === "complete" ? state : null;
  }, `Navigation to ${url}`);
}

async function readServiceWorkerState(client) {
  return client.evaluate(`(async () => {
    if (!('serviceWorker' in navigator)) {
      return { supported: false, controlled: false, registrations: [] };
    }
    const registrations = await navigator.serviceWorker.getRegistrations();
    const controller = navigator.serviceWorker.controller;
    return {
      supported: true,
      controlled: Boolean(controller),
      controllerScriptUrl: controller?.scriptURL || null,
      controllerState: controller?.state || null,
      registrations: registrations.map((registration) => ({
        scope: registration.scope,
        activeScriptUrl: registration.active?.scriptURL || null,
        activeState: registration.active?.state || null,
        installingState: registration.installing?.state || null,
        waitingState: registration.waiting?.state || null,
      })),
    };
  })()`);
}

async function prepareControlledServiceWorkerPage(client, url) {
  await navigate(client, url);
  let activated;
  try {
    activated = await waitFor(async () => {
      const state = await readServiceWorkerState(client);
      return state?.registrations.some(
        ({ activeState }) => activeState === "activated",
      )
        ? state
        : null;
    }, "The application service worker activation");
  } catch (error) {
    const state = await readServiceWorkerState(client);
    throw new Error(
      `${error.message}: ${JSON.stringify({
        state,
        errors: serviceWorkerErrors,
        versions: serviceWorkerVersions,
      })}`,
    );
  }
  assert.equal(activated.supported, true, "Service workers are not supported");

  await client.evaluate(
    `window.__vigieauBrowserSmokeBeforeReload = ${JSON.stringify(Date.now())}`,
  );
  resetObservations();
  await client.send("Page.reload");

  return waitFor(async () => {
    const pageState = await client.evaluate(`(() => ({
      readyState: document.readyState,
      markerStillPresent: Boolean(window.__vigieauBrowserSmokeBeforeReload),
    }))()`);
    assert.equal(pageState?.readyState, "complete", "Reload is not complete");
    assert.equal(
      pageState.markerStillPresent,
      false,
      "Reload did not create a new page execution context",
    );
    const state = await readServiceWorkerState(client);
    assert.equal(
      state?.controlled,
      true,
      `Reloaded page is not controlled: ${JSON.stringify(state)}`,
    );
    assert.equal(
      state.controllerState,
      "activated",
      `Service worker controller is not activated: ${JSON.stringify(state)}`,
    );
    assert.ok(
      state.controllerScriptUrl,
      `Service worker controller has no script URL: ${JSON.stringify(state)}`,
    );
    assert.equal(
      state.controllerScriptUrl,
      expectedServiceWorkerUrl,
      `Unexpected service worker controller: ${JSON.stringify(state)}`,
    );
    return state;
  }, "The service worker controller after reload");
}

async function inspectServiceWorkerCaches(client) {
  const state = await client.evaluate(`(async () => {
    if (!('caches' in window)) {
      return { supported: false, cacheNames: [], entryCount: 0 };
    }
    const cacheNames = await caches.keys();
    const precacheCacheNames = cacheNames.filter((cacheName) =>
      cacheName.startsWith('workbox-precache')
    );
    const sensitiveEntryCounts = {
      pmtiles: 0,
      api: 0,
      zonePublication: 0,
    };
    let entryCount = 0;
    let precacheEntryCount = 0;
    for (const cacheName of cacheNames) {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();
      entryCount += requests.length;
      if (precacheCacheNames.includes(cacheName)) {
        precacheEntryCount += requests.length;
      }
      for (const request of requests) {
        const pathname = new URL(request.url).pathname;
        if (/\\.pmtiles$/i.test(pathname)) sensitiveEntryCounts.pmtiles++;
        if (/\\/api(?:\\/|$)/i.test(pathname)) sensitiveEntryCounts.api++;
        if (/\\/zones\\/publication(?:\\/|$)/i.test(pathname)) {
          sensitiveEntryCounts.zonePublication++;
        }
      }
    }
    return {
      supported: true,
      cacheNames,
      entryCount,
      precacheCacheNames,
      precacheEntryCount,
      sensitiveEntryCounts,
      sensitiveEntryCount: Object.values(sensitiveEntryCounts)
        .reduce((total, count) => total + count, 0),
    };
  })()`);
  assert.equal(state.supported, true, "CacheStorage is not supported");
  assert.ok(
    state.precacheCacheNames.length > 0 && state.precacheEntryCount > 0,
    `Service worker precache is empty: ${JSON.stringify(state)}`,
  );
  assert.equal(
    state.sensitiveEntryCount,
    0,
    `Service worker caches contain network-only resources: ${JSON.stringify(state)}`,
  );
  return state;
}

async function clickViewportPoint(client, point) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function readTarbesLookupPayload(client, lookup) {
  const response = await waitFor(async () => {
    const body = await client.send("Network.getResponseBody", {
      requestId: lookup.requestId,
    });
    const text = body.base64Encoded
      ? Buffer.from(body.body, "base64").toString("utf8")
      : body.body;
    return text ? { payload: JSON.parse(text) } : null;
  }, "The Tarbes municipality response body");
  return response.payload;
}

async function selectTarbesWaterType(client, type) {
  await waitFor(async () => {
    return client.evaluate(`(() => {
      const isVisible = (element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      };
      const select = [...document.querySelectorAll('select#type_eau')]
        .find(isVisible);
      const type = ${JSON.stringify(type)};
      if (!select || ![...select.options].some((option) => option.value === type)) {
        return null;
      }
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        'value'
      ).set;
      valueSetter.call(select, type);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return select.value === type ? true : null;
    })()`);
  }, `The Tarbes ${type} water-type selection`);
}

async function inspectTarbesResourceModal(client) {
  return client.evaluate(`(() => {
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        bounds.width > 0 &&
        bounds.height > 0
      );
    };
    const expectedTitle = ${JSON.stringify(tarbesResourceModalTitle)};
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const dialog = [
      ...document.querySelectorAll('[role="dialog"], dialog, .fr-modal'),
    ].filter(isVisible).find((candidate) => {
      const title = candidate.querySelector(
        '.fr-modal__title, [aria-level], h1, h2, h3'
      );
      return normalize(title?.textContent) === expectedTitle;
    });
    if (!dialog) return null;
    const select = [...dialog.querySelectorAll('select')].find(isVisible);
    return {
      title: expectedTitle,
      options: [...(select?.options || [])]
        .filter((option) => option.value)
        .map((option) => ({
          id: String(option.value),
          text: normalize(option.textContent),
        })),
    };
  })()`);
}

async function chooseTarbesZone(client, zoneId) {
  await client.evaluate(`(() => {
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        bounds.width > 0 &&
        bounds.height > 0
      );
    };
    const expectedTitle = ${JSON.stringify(tarbesResourceModalTitle)};
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const dialog = [
      ...document.querySelectorAll('[role="dialog"], dialog, .fr-modal'),
    ].filter(isVisible).find((candidate) => {
      const title = candidate.querySelector(
        '.fr-modal__title, [aria-level], h1, h2, h3'
      );
      return normalize(title?.textContent) === expectedTitle;
    });
    const select = [...(dialog?.querySelectorAll('select') || [])]
      .find(isVisible);
    const zoneId = ${JSON.stringify(zoneId)};
    const option = [...(select?.options || [])]
      .find((candidate) => String(candidate.value) === zoneId);
    const button = [...(dialog?.querySelectorAll('button') || [])]
      .find((candidate) => normalize(candidate.textContent) === 'Valider');
    if (!select || !option || !button) {
      throw new Error('Unable to select the expected Tarbes alert zone');
    }
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value'
    ).set;
    valueSetter.call(select, zoneId);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    button.click();
    return true;
  })()`);
}

async function inspectTarbesSituation(client) {
  return client.evaluate(`(() => {
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        bounds.width > 0 &&
        bounds.height > 0
      );
    };
    const header = document.querySelector('.situation-status-header');
    const heading = [...(header?.querySelectorAll('h1') || [])].find(isVisible);
    const waterType = [...document.querySelectorAll('select#type_eau')]
      .find(isVisible);
    if (!header || !heading || !waterType || !isVisible(header)) return null;
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const expectedModalTitle = ${JSON.stringify(tarbesResourceModalTitle)};
    const resourceModalVisible = [
      ...document.querySelectorAll('[role="dialog"], dialog, .fr-modal'),
    ].filter(isVisible).some((candidate) => {
      const title = candidate.querySelector(
        '.fr-modal__title, [aria-level], h1, h2, h3'
      );
      return normalize(title?.textContent) === expectedModalTitle;
    });
    return {
      heading: normalize(heading.textContent),
      headerClasses: [...header.classList],
      selectedType: waterType.value,
      resourceModalVisible,
    };
  })()`);
}

async function assertTarbesSituationRendering(client, payload) {
  const expectations = buildTarbesSituationExpectations(payload);
  const rendered = [];

  for (const expectation of expectations) {
    await selectTarbesWaterType(client, expectation.type);
    const selectedZone = expectation.zones[0] || null;

    if (expectation.zones.length > 1) {
      const expectedIds = expectation.zones.map((zone) => zone.id).sort();
      const modal = await waitFor(async () => {
        const candidate = await inspectTarbesResourceModal(client);
        if (!candidate) return null;
        const candidateIds = candidate.options
          .map((option) => option.id)
          .sort();
        return JSON.stringify(candidateIds) === JSON.stringify(expectedIds)
          ? candidate
          : null;
      }, `The Tarbes ${expectation.type} resource modal`);
      assert.deepEqual(
        modal.options.map((option) => option.id).sort(),
        expectedIds,
        `Tarbes did not render every ${expectation.type} zone from the API response`,
      );
      for (const zone of expectation.zones) {
        const option = modal.options.find(
          (candidate) => candidate.id === zone.id,
        );
        assert.ok(option, `Tarbes did not render zone ${zone.id}`);
        if (zone.name) {
          assert.equal(
            option.text,
            zone.name,
            `Tarbes rendered the wrong name for zone ${zone.id}`,
          );
        }
      }
      await chooseTarbesZone(client, selectedZone.id);
    }

    const situation = await waitFor(async () => {
      const state = await inspectTarbesSituation(client);
      if (
        !state ||
        state.selectedType !== expectation.type ||
        state.resourceModalVisible
      ) {
        return null;
      }
      const expectedClass = `situation-level-${selectedZone?.severityRank ?? 0}`;
      if (!state.headerClasses.includes(expectedClass)) return null;
      if (selectedZone && !/\best en\b/i.test(state.heading)) return null;
      if (
        !selectedZone &&
        !/pas concern[\u00e9e]e par des restrictions/i.test(state.heading)
      ) {
        return null;
      }
      return state;
    }, `The Tarbes ${expectation.type} situation rendered from the API response`);

    rendered.push({
      type: expectation.type,
      zoneCount: expectation.zones.length,
      selectedZoneId: selectedZone?.id ?? null,
      heading: situation.heading,
    });
  }

  return rendered;
}

async function runTarbesAddressJourney(client) {
  await client.send("Network.setBypassServiceWorker", { bypass: true });
  resetObservations();
  await navigate(client, `${frontBase}/?browser-smoke=tarbes-address`);

  await waitFor(async () => {
    return client.evaluate(`(() => {
      const input = document.querySelector(
        '[data-cy="AddressSearchInput"] input[role="combobox"]'
      );
      const bounds = input?.getBoundingClientRect();
      return input && bounds?.width > 0 && bounds?.height > 0 ? true : null;
    })()`);
  }, "The public address search input");
  await client.evaluate(`(() => {
    const input = document.querySelector(
      '[data-cy="AddressSearchInput"] input[role="combobox"]'
    );
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    ).set;
    valueSetter.call(input, '');
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'deleteContentBackward',
    }));
    input.focus();
    return true;
  })()`);
  await client.send("Input.insertText", { text: "Tarbes" });

  const tarbesOption = await waitFor(async () => {
    return client.evaluate(`(() => {
      const root = document.querySelector('[data-cy="AddressSearchInput"]');
      const options = [...(root?.querySelectorAll('[role="option"]') || [])];
      const option = options.find(
        (candidate) => candidate.textContent.replace(/\\s+/g, ' ').trim() === 'Tarbes, 65'
      );
      const bounds = option?.getBoundingClientRect();
      if (!option || !bounds || bounds.width <= 0 || bounds.height <= 0) {
        return null;
      }
      return {
        text: option.textContent.replace(/\\s+/g, ' ').trim(),
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2,
      };
    })()`);
  }, "The Tarbes municipality autocomplete option");
  await clickViewportPoint(client, tarbesOption);

  const consultButton = await waitFor(async () => {
    return client.evaluate(`(() => {
      const input = document.querySelector(
        '[data-cy="AddressSearchInput"] input[role="combobox"]'
      );
      const button = document.querySelector(
        '[data-cy="MainRestrictionSearchForm"] [data-cy="MainRestrictionSearchSubmit"]'
      );
      if (
        input?.value !== 'Tarbes, 65' ||
        !button ||
        button.disabled
      ) {
        return null;
      }
      button.scrollIntoView({ block: 'center', inline: 'center' });
      const bounds = button.getBoundingClientRect();
      if (
        bounds.width <= 0 ||
        bounds.height <= 0 ||
        bounds.top < 0 ||
        bounds.bottom > window.innerHeight
      ) return null;
      return {
        inputValue: input.value,
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2,
      };
    })()`);
  }, "The enabled restrictions lookup button for Tarbes");
  await clickViewportPoint(client, consultButton);

  const lookup = await waitFor(
    () => zoneLookupResponses.at(-1) || null,
    "The Tarbes municipality zone lookup",
  );
  const lookupOutcome = resolveTarbesLookupOutcome(
    tarbesCheckMode,
    lookup.status,
  );

  if (lookupOutcome === "situation") {
    const payload = await readTarbesLookupPayload(client, lookup);
    await waitFor(async () => {
      const path = await client.evaluate("location.pathname");
      return path === "/situation" ? path : null;
    }, "The Tarbes situation navigation");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const situation = await client.evaluate(`(() => {
      const isVisible = (element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      };
      const precisionTitle = ${JSON.stringify(tarbesExpectedModalTitle)};
      const precisionModal = [
        ...document.querySelectorAll('[role="dialog"], dialog, .fr-modal'),
      ].filter(isVisible).find((dialog) => {
        const title = dialog.querySelector(
          '.fr-modal__title, [aria-level], h1, h2, h3'
        );
        return (title?.textContent || '').replace(/\\s+/g, ' ').trim() ===
          precisionTitle;
      });
      return {
        path: location.pathname,
        precisionModal: precisionModal
          ? (precisionModal.textContent || '').replace(/\\s+/g, ' ').trim()
          : null,
      };
    })()`);
    assert.equal(
      situation.path,
      "/situation",
      `Tarbes did not remain on the situation page: ${JSON.stringify(situation)}`,
    );
    assert.equal(
      situation.precisionModal,
      null,
      `Tarbes displayed an erroneous precision modal after a successful lookup: ${JSON.stringify(situation)}`,
    );
    assert.deepEqual(
      fatalErrors,
      [],
      "Tarbes situation navigation raised an unhandled browser exception",
    );
    const renderedSituation = await assertTarbesSituationRendering(
      client,
      payload,
    );
    assert.deepEqual(
      fatalErrors,
      [],
      "Tarbes rendered situation checks raised an unhandled browser exception",
    );

    return {
      selectedOption: tarbesOption.text,
      inputValue: consultButton.inputValue,
      lookupStatus: lookup.status,
      outcome: lookupOutcome,
      modalTitle: null,
      path: situation.path,
      renderedSituation,
    };
  }

  const modal = await waitFor(async () => {
    return client.evaluate(`(() => {
      const isVisible = (element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      };
      const candidates = [
        ...document.querySelectorAll('[role="dialog"], dialog, .fr-modal'),
      ];
      const dialog =
        candidates.find(
          (candidate) =>
            candidate.getAttribute('aria-modal') === 'true' && isVisible(candidate)
        ) || candidates.find(isVisible);
      if (!dialog) return null;
      const title = dialog.querySelector(
        '.fr-modal__title, [aria-level], h1, h2, h3'
      );
      return {
        title: title?.textContent || '',
        text: dialog.textContent || '',
        path: location.pathname,
      };
    })()`);
  }, "The Tarbes precision modal");
  const modalTitle = String(modal.title).replace(/\s+/g, " ").trim();
  assert.equal(
    modalTitle,
    tarbesExpectedModalTitle,
    `Tarbes displayed the wrong modal: ${JSON.stringify(modal)}`,
  );
  assert.doesNotMatch(
    String(modal.text),
    tarbesForbiddenMessage,
    `Tarbes displayed a false no-restriction message: ${JSON.stringify(modal)}`,
  );
  assert.equal(
    modal.path,
    "/",
    "Tarbes municipality lookup navigated away instead of asking for precision",
  );

  return {
    selectedOption: tarbesOption.text,
    inputValue: consultButton.inputValue,
    lookupStatus: lookup.status,
    outcome: lookupOutcome,
    modalTitle,
    path: modal.path,
  };
}

async function captureMapPixels(client, scenario, mapState) {
  const clipX = Math.max(0, mapState.x);
  const clipY = Math.max(0, mapState.y);
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
    clip: {
      x: clipX,
      y: clipY,
      width: Math.min(mapState.width - (clipX - mapState.x), scenario.width),
      height: Math.min(mapState.height - (clipY - mapState.y), scenario.height),
      scale: 1,
    },
  });
  return inspectPixels(Buffer.from(screenshot.data, "base64"));
}

async function runScenario(client, scenario) {
  await applyViewport(client, scenario);
  await client.send("Network.setBypassServiceWorker", {
    bypass: !scenario.requireServiceWorker,
  });
  resetObservations();

  const url = `${frontBase}/carte/?browser-smoke=${encodeURIComponent(
    scenario.name,
  )}`;
  let serviceWorker = null;
  if (scenario.requireServiceWorker) {
    serviceWorker = await prepareControlledServiceWorkerPage(client, url);
  } else {
    await navigate(client, url);
  }

  const mapState = await waitFor(async () => {
    const state = await client.evaluate(`(() => {
      const canvas = document.querySelector('canvas.maplibregl-canvas');
      const bounds = canvas?.getBoundingClientRect();
      const errorText = [...document.querySelectorAll('.fr-alert--error')]
        .map((element) => element.textContent || '')
        .join(' ')
        .trim();
      if (
        !canvas ||
        !bounds ||
        bounds.width < ${Math.max(240, Math.floor(scenario.width * 0.6))} ||
        bounds.height < 180
      ) {
        return null;
      }
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      return {
        x: bounds.left + window.scrollX,
        y: bounds.top + window.scrollY,
        width: bounds.width,
        height: bounds.height,
        backingWidth: canvas.width,
        backingHeight: canvas.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        webgl: Boolean(gl && !gl.isContextLost()),
        errorText,
      };
    })()`);
    return state?.webgl ? state : null;
  }, `${scenario.name} MapLibre canvas`);

  assert.equal(
    mapState.errorText,
    "",
    `${scenario.name} public map displays: ${mapState.errorText}`,
  );
  assert.equal(
    mapState.viewportWidth,
    scenario.width,
    `${scenario.name} did not use the requested viewport width`,
  );

  const tileResponses = await waitFor(() => {
    const successful = pmtilesResponses.filter((response) =>
      [200, 206].includes(response.status),
    );
    const ranges = new Set(
      successful.map(({ range }) => range).filter(Boolean),
    );
    return successful.length >= 2 && ranges.size >= 2
      ? { successful, ranges: [...ranges] }
      : null;
  }, `${scenario.name} PMTiles header and tile range requests`);

  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const pixels = await waitFor(async () => {
    const inspected = await captureMapPixels(client, scenario, mapState);
    assert.ok(
      inspected.quantizedColors >= 24,
      `${scenario.name} map canvas has too few colors: ${JSON.stringify(inspected)}`,
    );
    assert.ok(
      inspected.luminanceRange >= 40,
      `${scenario.name} map canvas has insufficient contrast: ${JSON.stringify(inspected)}`,
    );
    assert.ok(
      inspected.luminanceStdDev >= 8,
      `${scenario.name} map canvas appears blank: ${JSON.stringify(inspected)}`,
    );
    assert.ok(
      inspected.dominantColorRatio < 0.9,
      `${scenario.name} map canvas is covered by one color: ${JSON.stringify(inspected)}`,
    );
    assert.ok(
      inspected.zonePalettePixels >= minZonePalettePixels,
      `${scenario.name} zone layer has too few palette pixels: ${JSON.stringify(inspected)}`,
    );
    assert.ok(
      inspected.zonePaletteRatio >= minZonePaletteRatio,
      `${scenario.name} zone layer palette coverage is too low: ${JSON.stringify(inspected)}`,
    );
    return inspected;
  }, `${scenario.name} rendered zone layer`);

  assert.deepEqual(
    fatalErrors,
    [],
    `${scenario.name} map raised an unhandled browser exception`,
  );
  const cacheStorage = scenario.requireServiceWorker
    ? await inspectServiceWorkerCaches(client)
    : null;
  const tarbesAddressJourney =
    scenario.name === "desktop" && tarbesCheckMode !== "skip"
      ? await runTarbesAddressJourney(client)
      : null;
  return {
    name: scenario.name,
    viewport: {
      width: scenario.width,
      height: scenario.height,
      mobile: scenario.mobile,
    },
    serviceWorker,
    cacheStorage,
    tarbesAddressJourney,
    canvas: mapState,
    pixels,
    pmtilesRanges: tileResponses.ranges,
    pmtilesResponseCount: tileResponses.successful.length,
  };
}

const chromePath = await findChrome();
const userDataDir = await mkdtemp(join(tmpdir(), "vigieau-browser-smoke-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--window-size=1440,1000",
    "--force-device-scale-factor=1",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let chromeErrors = "";
chrome.stderr.on("data", (chunk) => {
  chromeErrors = `${chromeErrors}${chunk}`.slice(-10_000);
});

let client;
let smokeError = null;
try {
  const devTools = await waitForChromeDevTools({
    activePortPath: join(userDataDir, "DevToolsActivePort"),
    child: chrome,
    timeoutMs: chromeStartupTimeoutMs,
  });
  client = new DevToolsClient(devTools.webSocketDebuggerUrl);
  await client.connect();
  client.onEvent((event) => {
    if (event.method === "Network.requestWillBeSent") {
      requests.set(event.params.requestId, {
        url: event.params.request.url,
        range:
          event.params.request.headers?.Range ||
          event.params.request.headers?.range ||
          null,
      });
    } else if (event.method === "Network.responseReceived") {
      const request = requests.get(event.params.requestId);
      if (request?.url.includes(".pmtiles")) {
        pmtilesResponses.push({
          url: request.url,
          range: request.range,
          status: event.params.response.status,
          fromServiceWorker: event.params.response.fromServiceWorker,
        });
      }
      if (request?.url && isTarbesZoneLookupUrl(request.url)) {
        zoneLookupResponses.push({
          requestId: event.params.requestId,
          status: event.params.response.status,
          fromServiceWorker: event.params.response.fromServiceWorker,
        });
      }
    } else if (event.method === "Runtime.exceptionThrown") {
      fatalErrors.push(
        event.params.exceptionDetails?.exception?.description ||
          event.params.exceptionDetails?.text ||
          "Unhandled browser exception",
      );
    } else if (event.method === "ServiceWorker.workerErrorReported") {
      serviceWorkerErrors.push(event.params);
    } else if (event.method === "ServiceWorker.workerVersionUpdated") {
      serviceWorkerVersions.push(...event.params.versions);
    }
  });

  await Promise.all([
    client.send("Page.enable"),
    client.send("Runtime.enable"),
    client.send("Network.enable"),
    client.send("ServiceWorker.enable"),
  ]);

  const results = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(client, scenario));
  }
  console.log(
    JSON.stringify({
      status: "ok",
      front: frontBase,
      zonePaletteThresholds: {
        maxDistance: zonePaletteMaxDistance,
        minPixels: minZonePalettePixels,
        minRatio: minZonePaletteRatio,
      },
      tarbesCheckMode,
      scenarios: results,
    }),
  );
} catch (error) {
  smokeError = new Error(
    `${error.message}\nChrome stderr:\n${chromeErrors.slice(-3000)}`,
  );
  throw smokeError;
} finally {
  let cleanupError = null;
  try {
    client?.close();
  } catch (error) {
    cleanupError = error;
  }
  try {
    await terminateChild({ child: chrome });
  } catch (error) {
    cleanupError ??= error;
  }
  try {
    await rm(userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError) {
    if (!smokeError) {
      throw cleanupError;
    }
    console.error(`Browser smoke cleanup failed: ${cleanupError.message}`);
  }
}
