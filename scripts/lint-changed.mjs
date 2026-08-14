import { execFileSync, spawnSync } from "node:child_process";

const fallbackBase = "HEAD^";
const requestedBase = process.env.LINT_BASE_SHA?.trim() || process.argv[2];

function validCommit(ref) {
  if (!ref || /^0+$/.test(ref)) return false;
  const result = spawnSync("git", ["cat-file", "-e", `${ref}^{commit}`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

const base = validCommit(requestedBase) ? requestedBase : fallbackBase;
const diffRange = validCommit(base) ? `${base}...HEAD` : "HEAD";
const changedFiles = execFileSync(
  "git",
  ["diff", "--name-only", "--diff-filter=ACMR", diffRange],
  { encoding: "utf8" },
)
  .split("\n")
  .map((file) => file.trim())
  .filter(Boolean);

const groups = [
  { root: "apps/backend", extensions: /\.ts$/ },
  { root: "apps/backend-admin", extensions: /\.ts$/ },
  { root: "apps/frontend", extensions: /\.(?:js|mjs|cjs|ts|vue)$/ },
  { root: "apps/frontend-admin", extensions: /\.(?:js|mjs|cjs|ts|vue)$/ },
];

let failed = false;
for (const group of groups) {
  const prefix = `${group.root}/`;
  const files = changedFiles
    .filter((file) => file.startsWith(prefix) && group.extensions.test(file))
    .map((file) => file.slice(prefix.length));

  if (files.length === 0) continue;

  const result = spawnSync("npm", ["exec", "--", "eslint", ...files], {
    cwd: group.root,
    stdio: "inherit",
  });
  failed ||= result.status !== 0;
}

if (failed) process.exitCode = 1;
