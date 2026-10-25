import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function verifyPwaBuild(appDirectory) {
  const outputRoot = pathToFileURL(`${join(appDirectory, ".output/public")}/`);
  const clientBundleRoot = new URL("_nuxt/", outputRoot);
  const [serviceWorker, webManifest, nginxConfig, clientBundleFiles] =
    await Promise.all([
      readFile(new URL("sw.js", outputRoot), "utf8"),
      readFile(new URL("manifest.webmanifest", outputRoot), "utf8"),
      readFile(join(appDirectory, "nginx.conf"), "utf8"),
      readdir(clientBundleRoot),
    ]);

  const clientBundles = await Promise.all(
    clientBundleFiles
      .filter((file) => file.endsWith(".js"))
      .map((file) => readFile(new URL(file, clientBundleRoot), "utf8")),
  );

  assert.doesNotMatch(
    serviceWorker,
    /url\s*:\s*(["'`])manifest\.webmanifest\1/,
    "The mutable web manifest must not be precached",
  );
  assert.match(
    serviceWorker,
    /\/manifest\\\.webmanifest/,
    "The web manifest has no runtime cache exclusion",
  );
  assert.match(
    serviceWorker,
    /NetworkOnly/,
    "The network-only policy is absent",
  );
  assert.match(
    nginxConfig,
    /^\s*absolute_redirect\s+off\s*;/m,
    "Nginx must keep directory redirects relative behind the HTTPS proxy",
  );
  assert.ok(
    clientBundles.some(
      (bundle) =>
        bundle.includes("vite-pwa:nuxt:client:plugin") &&
        /(["'`])\/sw\.js\1/.test(bundle),
    ),
    "The generated client no longer auto-registers /sw.js",
  );

  const parsedManifest = JSON.parse(webManifest);
  assert.equal(parsedManifest.name, "VigiEau");
  assert.ok(parsedManifest.icons?.length, "The web manifest has no icon");

  return { status: "ok", precachedManifest: false };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  console.log(
    JSON.stringify(
      await verifyPwaBuild(
        fileURLToPath(new URL("../apps/frontend/", import.meta.url)),
      ),
    ),
  );
}
