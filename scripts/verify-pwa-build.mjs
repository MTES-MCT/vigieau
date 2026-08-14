import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const outputRoot = new URL("../apps/frontend/.output/public/", import.meta.url);
const clientBundleRoot = new URL("_nuxt/", outputRoot);
const [serviceWorker, webManifest, nginxConfig, clientBundleFiles] =
  await Promise.all([
    readFile(new URL("sw.js", outputRoot), "utf8"),
    readFile(new URL("manifest.webmanifest", outputRoot), "utf8"),
    readFile(new URL("../apps/frontend/nginx.conf", import.meta.url), "utf8"),
    readdir(clientBundleRoot),
  ]);

const clientBundles = await Promise.all(
  clientBundleFiles
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFile(new URL(file, clientBundleRoot), "utf8")),
);

assert.doesNotMatch(
  serviceWorker,
  /url:"manifest\.webmanifest"/,
  "The mutable web manifest must not be precached",
);
assert.match(
  serviceWorker,
  /\/manifest\\\.webmanifest/,
  "The web manifest has no runtime cache exclusion",
);
assert.match(serviceWorker, /NetworkOnly/, "The network-only policy is absent");
assert.match(
  nginxConfig,
  /^\s*absolute_redirect\s+off\s*;/m,
  "Nginx must keep directory redirects relative behind the HTTPS proxy",
);
assert.ok(
  clientBundles.some(
    (bundle) =>
      bundle.includes("vite-pwa:nuxt:client:plugin") &&
      bundle.includes('"/sw.js"'),
  ),
  "The generated client no longer auto-registers /sw.js",
);

const parsedManifest = JSON.parse(webManifest);
assert.equal(parsedManifest.name, "VigiEau");
assert.ok(parsedManifest.icons?.length, "The web manifest has no icon");

console.log(JSON.stringify({ status: "ok", precachedManifest: false }));
