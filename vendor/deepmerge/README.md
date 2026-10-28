# VigiEau deepmerge security fork

This narrowly scoped fork preserves deepmerge 4.3.1, upstream commit
`5b87756a5671635679001cbac72aa42f23472c81`, under its original MIT license.
The original npm archive is retained and SHA512-verified before each rebuild.

GHSA-gcqx-w48m-w2h4 / CVE-2026-93753 allows an enumerable own `__proto__`
property in merge inputs to poison the returned object's prototype. The
upstream target-property copy bypasses its existing inherited-property guard.
This is returned-object poisoning, not a claim of global prototype pollution.

`define-property.js` supplies a data-property writer. The build inserts it and
replaces exactly three destination assignments in the source and both shipped
CommonJS/UMD bundles. All keys, including symbols and legitimate constructor
fields, remain ordinary own enumerable writable properties; no prototype
setter is invoked. The upstream source filtering, cloning, arrays, merge.all,
customMerge and type declarations are otherwise unchanged. Caller-supplied
getters, customMerge and arrayMerge callbacks remain trusted application code.

Rebuild with the repository's pinned Node/npm versions:

```sh
node scripts/build-deepmerge-security-fork.mjs
node scripts/build-deepmerge-security-fork.mjs --check
node --test scripts/deepmerge-security.test.mjs
```

The same private archive is installed by all four apps. It has no install
scripts or new dependencies. Tests first reproduce the flaw on the unmodified
archive, then check every installed fork and both distributions, including
prototype keys, constructors, symbols and custom callbacks. CI also verifies
byte-for-byte archive reproducibility. An empty npm audit is not proof of the
fix; these behavior tests are mandatory.

Replace this fork with an upstream patched release once it passes the same
tests. Do not replace it with another unpatched package merely to change the
name checked by npm audit.
