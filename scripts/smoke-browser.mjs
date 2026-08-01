import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

const frontBase = (
  process.env.VIGIEAU_FRONT_URL || "https://vigieau.gouv.fr"
).replace(/\/+$/, "");
const expectedServiceWorkerUrl = new URL("/sw.js", frontBase).href;
const tarbesExpectedModalTitle = "Nous avons besoin de plus de pr\u00e9cision";
const tarbesForbiddenMessage =
  /Pas d['\u2019]arr\u00eat\u00e9 en vigueur|Aucune restriction/i;
const timeoutMs = Number(
  process.env.VIGIEAU_BROWSER_SMOKE_TIMEOUT_MS || 60_000,
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
const tarbesCheckMode =
  process.env.VIGIEAU_BROWSER_TARBES_MODE?.trim() || "strict";

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
assert.ok(
  ["strict", "skip"].includes(tarbesCheckMode),
  "VIGIEAU_BROWSER_TARBES_MODE must be strict or skip",
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

async function waitForDevToolsFile(path, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    assert.equal(
      child.exitCode,
      null,
      "Chrome exited before DevTools was ready",
    );
    try {
      const contents = await readFile(path, "utf8");
      const [port] = contents.trim().split("\n");
      if (port) return Number(port);
    } catch {
      // Chrome creates the file asynchronously.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome DevTools did not become ready");
}

async function getPageDevToolsUrl(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200, "Chrome did not expose its page target");
  const targets = await response.json();
  const page = targets.find(
    (target) => target.type === "page" && target.webSocketDebuggerUrl,
  );
  assert.ok(page, "Chrome has no debuggable page target");
  return page.webSocketDebuggerUrl;
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
      const button = [...document.querySelectorAll('button')].find(
        (candidate) =>
          candidate.textContent.replace(/\\s+/g, ' ').trim() ===
          'Je consulte les restrictions'
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
  await client.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(
      (candidate) =>
        candidate.textContent.replace(/\\s+/g, ' ').trim() ===
        'Je consulte les restrictions'
    );
    button.click();
    return true;
  })()`);

  const lookup = await waitFor(
    () => zoneLookupResponses.at(-1) || null,
    "The Tarbes municipality zone lookup",
  );
  assert.equal(
    lookup.status,
    409,
    `Tarbes municipality lookup returned ${lookup.status}`,
  );

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
    scenario.name === "desktop" && tarbesCheckMode === "strict"
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
try {
  const devToolsPort = await waitForDevToolsFile(
    join(userDataDir, "DevToolsActivePort"),
    chrome,
  );
  const devToolsUrl = await getPageDevToolsUrl(devToolsPort);
  client = new DevToolsClient(devToolsUrl);
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
      if (request?.url) {
        const requestUrl = new URL(request.url);
        if (
          /\/(?:api\/)?zones\/?$/.test(requestUrl.pathname) &&
          requestUrl.searchParams.get("commune") === "65440"
        ) {
          zoneLookupResponses.push({
            status: event.params.response.status,
            fromServiceWorker: event.params.response.fromServiceWorker,
          });
        }
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
  throw new Error(
    `${error.message}\nChrome stderr:\n${chromeErrors.slice(-3000)}`,
  );
} finally {
  client?.close();
  if (chrome.exitCode === null && chrome.signalCode === null) {
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(finish, 2_000);
      chrome.once("exit", finish);
      chrome.kill("SIGTERM");
    });
  }
  await rm(userDataDir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}
