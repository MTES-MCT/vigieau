# VigiEau listhen security fork

This is a narrowly scoped fork of `unjs/listhen` 1.10.1, commit
`2466b698997f6d5006c22f36ab54379df277cf5f`, under its original MIT license.
The unmodified npm distribution is retained in `upstream/listhen-1.10.1.tgz`.
Its SHA512 is checked before every rebuild by
`scripts/build-listhen-security-fork.mjs`.

## Security change

`node-forge` 1.4.0 is affected by GHSA-86w9-cpqp-85rv. This fork removes its
code and dependency, rather than hiding its advisory or renaming it.
Certificate generation uses `selfsigned` 5.5.0 (upstream commit
`bb4c2a87cb322727fa7de935938cab1f78ea8622`), native WebCrypto and maintained
X.509 libraries. Encrypted private keys and PKCS#12 stores are handled by
Node crypto/TLS and OpenSSL. SHA256 is selected explicitly.
The automatically generated CA has a distinct issuer name; the server
certificate keeps the requested common name and SANs so native TLS can
validate the generated chain without disabling certificate verification.

`certificate.cjs` is the complete replacement implementation. The build
script replaces only the upstream certificate block, removes forge imports,
updates the package metadata, and extends the HTTPS result type for native
PFX options. All other runtime functionality comes from the pinned upstream
distribution. CommonJS, ESM and CLI entrypoints are retained. The original
PEM `Certificate` interface is unchanged; `Listener.https` additionally
accepts a native PFX result.

## Rebuild and verify

Use Node 24.22.1 and npm 11.21.1, with standard `tar` available:

```sh
node scripts/build-listhen-security-fork.mjs
node scripts/build-listhen-security-fork.mjs --check
node --test scripts/listhen-security.test.mjs
```

There is no extra package installation or build dependency tree for the
fork. The generator uses the pinned published upstream code and the local
replacement implementation. Both application vendor directories receive
the exact same archive and can be installed independently by Scalingo.

The archive is private, has no installation scripts and declares selfsigned
as a normal dependency so its dependency graph remains visible to npm audit.
The test suite checks certificate behavior, native TLS rejection, module
entrypoints and the installed dependency closure. Re-run full application
audits and regression suites after rebuilding; an empty advisory report is
not a substitute for those checks.

Remove this fork when upstream listhen publishes an equivalent forge-free
implementation that passes the same tests. Do not substitute an unpatched
package simply because its different name produces an empty audit result.
