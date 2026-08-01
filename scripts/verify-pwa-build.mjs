import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const outputRoot = new URL("../apps/frontend/.output/public/", import.meta.url);
const [serviceWorker, webManifest] = await Promise.all([
  readFile(new URL("sw.js", outputRoot), "utf8"),
  readFile(new URL("manifest.webmanifest", outputRoot), "utf8"),
]);

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

const parsedManifest = JSON.parse(webManifest);
assert.equal(parsedManifest.name, "VigiEau");
assert.ok(parsedManifest.icons?.length, "The web manifest has no icon");

console.log(JSON.stringify({ status: "ok", precachedManifest: false }));
