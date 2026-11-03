# VigiEau minimatch compatibility security fork

This private fork preserves minimatch 10.2.6's matching engine, `makeRe`, `AST`,
regexp pattern sets, CommonJS/ESM builds and type declarations. Its pinned npm
archive is SHA512-verified before every rebuild; the original Blue Oak license
is retained in both output archives.

It backports the three runtime changes in upstream commit
[77a0f5c](https://github.com/isaacs/minimatch/commit/77a0f5c), fixing
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249):

- Stop `**/..` splitting once `braceExpandMax` patterns exist (default 100,000).
- Skip the quadratic deduplication pass for sets larger than 1,000 patterns.

Both shipped JavaScript distributions are patched. Their now-inaccurate index
source maps are removed, while all other upstream files remain unchanged.
Dependencies stay visible to npm audit, with brace-expansion pinned to 5.0.12.
There are no installation scripts and no audit exceptions.

The named-export archive replaces versions 9 and 10. The legacy archive adds
only a callable CommonJS facade with `optimizationLevel: 0` as its default for
versions 3 and 5. Both archives contain the same corrected engine. They do not
rename an unchanged vulnerable implementation. A direct minimatch 11 override
would remove `makeRe`, `AST` and regexp internals required by existing consumers.
The old 3/5 versions do not contain this preprocessing algorithm; migrating them
to the corrected engine also avoids relying on an exception to the advisory's
broad `<11.0.1` affected range.

The fixture records 2,128 real matcher results each from upstream 3.1.5 and
5.1.9, including braces, extglobs, dotfiles, negation and matching options.
Tests compare the facade with those results, reproduce bounded amplification
on the unmodified 10.2.6 archive, and check both patched distributions and real
installed glob 7 consumers. This is compatibility evidence for those cases,
not a claim that all historical edge cases are identical.

Rebuild and verify with the repository's pinned Node/npm versions:

```sh
node scripts/build-minimatch-security-fork.mjs
node scripts/build-minimatch-security-fork.mjs --check
node --test scripts/minimatch-security.test.mjs
```

The generator copies each archive to all four application vendor directories,
so each Scalingo application remains installable from its own package root.
Replace the fork once compatible upstream releases pass the same tests.
