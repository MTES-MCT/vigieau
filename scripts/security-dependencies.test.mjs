import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const applications = ["backend", "backend-admin", "frontend", "frontend-admin"];
const bracesIntegrity =
  "sha512-QY+Uq4s42STyIMPoRkBuUZfYyvz0uZuwuUburLwMx5N+lWqnHHaBxcKPtgKVKjTyFnS1q4ivKu9Wxi4VG7FE9Q==";

// GHSA-vfj7-8cjw-p6xm: test the fix, not just the scoped package's audit name.
// A child timeout also catches regressions that would loop on cyclic ASTs.
const bracesProbe = String.raw`
const assert = require("node:assert/strict");
const braces = require(process.argv[1]);
const nested = (count, open = "{", close = "}") => open.repeat(count) + "a" + close.repeat(count);
assert.deepEqual(braces.expand("zone-{01..03}"), ["zone-01", "zone-02", "zone-03"]);
assert.deepEqual(braces.expand("{surface,souterraine}/{alerte,crise}"), [
  "surface/alerte", "surface/crise", "souterraine/alerte", "souterraine/crise"
]);
assert.equal(braces.stringify(braces.parse("{a,b}")), "{a,b}");
assert.deepEqual(braces.expand("\\{a,b\\}"), ["{a,b}"]);
for (const [open, close] of [["{", "}"], ["(", ")"]]) {
  assert.doesNotThrow(() => braces.parse(nested(100, open, close)));
  for (const count of [101, 1000, 4500]) {
    for (const operation of [braces.parse, braces.compile, braces.expand]) {
      assert.throws(() => operation(nested(count, open, close)), /exceeds max depth/);
    }
  }
}
for (const maxDepth of [NaN, Infinity, "1000"]) {
  assert.throws(() => braces.parse(nested(101), { maxDepth }), /exceeds max depth/);
}
assert.throws(() => braces.parse("a", { maxDepth: -1 }), /maxDepth must be non-negative/);
assert.throws(() => braces.parse("a", { maxLength: NaN }), /maxLength must be/);
assert.throws(() => braces.parse(nested(2), { maxDepth: 1.5 }), /exceeds max depth/);
function deepAst() {
  const root = { type: "root", nodes: [] };
  let parent = root;
  for (let depth = 0; depth < 12000; depth++) {
    const child = { type: "paren", nodes: [], parent };
    parent.nodes.push(child);
    parent = child;
  }
  return root;
}
for (const operation of [braces.compile, braces.expand, braces.stringify]) {
  assert.throws(() => operation(deepAst()), /AST depth .* exceeds max depth/);
}
const cyclic = { type: "paren", nodes: [{ type: "text", value: "a" }] };
cyclic.parent = cyclic;
assert.throws(() => braces.expand({ type: "root", nodes: [cyclic] }), /contains a cycle/);
`;

for (const application of applications) {
  const cwd = resolve(root, "apps", application);
  const require = createRequire(join(cwd, "package.json"));

  test(`${application}: every installed braces copy is pinned and depth guarded`, async () => {
    const lock = JSON.parse(
      await readFile(join(cwd, "package-lock.json"), "utf8"),
    );
    const entries = Object.entries(lock.packages).filter(([path]) =>
      path.endsWith("node_modules/braces"),
    );
    assert.ok(
      entries.length > 0,
      "expected the globbing dependency to be audited",
    );
    for (const [path, metadata] of entries) {
      assert.equal(metadata.integrity, bracesIntegrity, path);
      const installed = JSON.parse(
        await readFile(join(cwd, path, "package.json"), "utf8"),
      );
      assert.equal(installed.name, "@dieub/braces-depth-guard");
      assert.equal(installed.version, "3.0.3-pn.3");
      execFileSync(process.execPath, ["-e", bracesProbe, join(cwd, path)], {
        timeout: 10_000,
        stdio: "pipe",
      });
    }
  });

  test(`${application}: coverage still loads YAML and JavaScript configuration`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "vigieau-coverage-config-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, "package.json"), '{"private":true}');
    await writeFile(
      join(directory, ".nycrc.yaml"),
      "all: true\ninclude:\n  - src/**/*.ts\nreporter:\n  - text\n  - json\ncheck-coverage: true\n",
    );
    await writeFile(
      join(directory, "nyc.config.cjs"),
      'module.exports = { all: true, include: ["src/**/*.ts"], reporter: ["text", "json"], checkCoverage: true };',
    );
    const { loadNycConfig } = require("@istanbuljs/load-nyc-config");
    const yaml = await loadNycConfig({
      cwd: directory,
      nycrcPath: ".nycrc.yaml",
    });
    const javascript = await loadNycConfig({
      cwd: directory,
      nycrcPath: "nyc.config.cjs",
    });
    assert.deepEqual(yaml, javascript);
    assert.equal(yaml.checkCoverage, true);
    assert.deepEqual(yaml.reporter, ["text", "json"]);
    const loaderRequire = createRequire(
      require.resolve("@istanbuljs/load-nyc-config"),
    );
    assert.equal(loaderRequire("js-yaml/package.json").version, "4.3.2");
  });

  if (application.startsWith("frontend")) {
    test(`${application}: globbing preserves extensions, exclusions and dotfiles`, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "vigieau-glob-security-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      await mkdir(join(directory, "src"));
      for (const file of [
        "map.ts",
        "chart.js",
        "map.spec.ts",
        ".hidden.ts",
        "README.md",
      ]) {
        await writeFile(join(directory, "src", file), "");
      }
      const glob = require("fast-glob");
      const patterns = ["src/**/*.{ts,js}", "!**/*.spec.ts"];
      assert.deepEqual((await glob(patterns, { cwd: directory })).sort(), [
        "src/chart.js",
        "src/map.ts",
      ]);
      assert.deepEqual(
        (await glob(patterns, { cwd: directory, dot: true })).sort(),
        ["src/.hidden.ts", "src/chart.js", "src/map.ts"],
      );
    });
  }
}
