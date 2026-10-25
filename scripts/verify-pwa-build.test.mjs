import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyPwaBuild } from "./verify-pwa-build.mjs";

async function fixture(t) {
  const app = await mkdtemp(join(tmpdir(), "vigieau-pwa-build-"));
  t.after(() => rm(app, { recursive: true, force: true }));
  const output = join(app, ".output/public");
  await mkdir(join(output, "_nuxt"), { recursive: true });
  await writeFile(
    join(output, "sw.js"),
    String.raw`registerRoute(/\/manifest\.webmanifest$/, new NetworkOnly());`,
  );
  await writeFile(
    join(output, "manifest.webmanifest"),
    JSON.stringify({ name: "VigiEau", icons: [{ src: "/favicon.png" }] }),
  );
  await writeFile(join(app, "nginx.conf"), "absolute_redirect off;");
  return { app, output, bundle: join(output, "_nuxt/client.js") };
}

test("accepts static service worker registration with every bundler quote style", async (t) => {
  const { app, bundle } = await fixture(t);
  for (const quote of ['"', "'", "`"]) {
    await writeFile(
      bundle,
      `/* vite-pwa:nuxt:client:plugin */ new Workbox(${quote}/sw.js${quote});`,
    );
    assert.deepEqual(await verifyPwaBuild(app), {
      status: "ok",
      precachedManifest: false,
    });
  }
});

test("rejects interpolated, missing and malformed service worker registration", async (t) => {
  const { app, bundle } = await fixture(t);
  for (const source of [
    "/* vite-pwa:nuxt:client:plugin */ new Workbox(`/sw.js${suffix}`);",
    "/* vite-pwa:nuxt:client:plugin */ new Workbox(`${prefix}/sw.js`);",
    '/* vite-pwa:nuxt:client:plugin */ new Workbox(`/sw.js");',
    '/* vite-pwa:nuxt:client:plugin */ new Workbox("/other.js");',
    'new Workbox("/sw.js");',
  ]) {
    await writeFile(bundle, source);
    await assert.rejects(verifyPwaBuild(app), /auto-registers/, source);
  }
});

test("rejects precaching the mutable manifest with any static quote style", async (t) => {
  const { app, output, bundle } = await fixture(t);
  await writeFile(
    bundle,
    '/* vite-pwa:nuxt:client:plugin */ new Workbox("/sw.js");',
  );
  for (const quote of ['"', "'", "`"]) {
    await writeFile(
      join(output, "sw.js"),
      `precache([{url:${quote}manifest.webmanifest${quote}}]);`,
    );
    await assert.rejects(verifyPwaBuild(app), /must not be precached/);
  }
});

test("keeps the runtime cache exclusion and HTTPS proxy guards", async (t) => {
  const { app, output, bundle } = await fixture(t);
  await writeFile(
    bundle,
    '/* vite-pwa:nuxt:client:plugin */ new Workbox("/sw.js");',
  );
  await writeFile(join(app, "nginx.conf"), "absolute_redirect on;");
  await assert.rejects(
    verifyPwaBuild(app),
    /keep directory redirects relative/,
  );
  await writeFile(join(app, "nginx.conf"), "absolute_redirect off;");
  await writeFile(join(output, "sw.js"), "new NetworkOnly();");
  await assert.rejects(verifyPwaBuild(app), /runtime cache exclusion/);
});
