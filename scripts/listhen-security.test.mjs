import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { constants, createHash, createPrivateKey, generateKeyPairSync, privateEncrypt, sign, verify, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const applicationRequire = createRequire(join(repository, 'apps/frontend/package.json'));
const packageRoot = process.env.VIGIEAU_LISTHEN_PACKAGE_DIR
  || resolve(dirname(applicationRequire.resolve('listhen')), '..');
const forkRequire = createRequire(join(packageRoot, 'package.json'));
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const { listen, listenAndWatch } = await import(pathToFileURL(join(packageRoot, 'dist/index.mjs')));
const certificates = forkRequire('./dist/certificate.cjs');
const listenerOptions = { port: 0, hostname: '127.0.0.1', public: false, showURL: false, isTest: true, autoClose: false };
let directory;
let generated;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'vigieau-listhen-security-'));
  generated = await certificates.generateCertificates({ domains: ['localhost', '127.0.0.1', '::1'], validityDays: 2 });
  await writeFile(join(directory, 'key.pem'), generated.cert.key, { mode: 0o600 });
  await writeFile(join(directory, 'cert.pem'), generated.cert.cert);
});
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function request(url, options = {}) {
  return new Promise((resolveResponse, reject) => {
    const req = https.get(url, { ...options, agent: false }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolveResponse({ status: response.statusCode, body }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('HTTPS test timeout')));
    req.on('error', reject);
  });
}

async function withListener(options, action) {
  const listener = await listen((_req, res) => res.end('secure response'), { ...listenerOptions, ...options });
  try {
    await action(listener);
  } finally {
    await listener.close();
  }
}

test('fork has an auditable dependency and no forge executable code', async () => {
  assert.equal(manifest.name, '@vigieau/listhen');
  assert.equal(manifest.version, '1.10.1-vigieau.1');
  assert.equal(manifest.dependencies.selfsigned, '5.5.0');
  assert.equal(manifest.dependencies['node-forge'], undefined);
  assert.equal(manifest.scripts, undefined);
  assert.throws(() => forkRequire.resolve('node-forge'), { code: 'MODULE_NOT_FOUND' });
  for (const entry of await readdir(join(packageRoot, 'dist'), { recursive: true })) {
    if (/\.(?:mjs|cjs)$/.test(entry)) {
      assert.doesNotMatch(await readFile(join(packageRoot, 'dist', entry), 'utf8'), /node-forge|forge\.pki|forge__default/);
    }
  }
});

test('ESM, CommonJS and CLI entrypoints keep their exports', async () => {
  const common = forkRequire('./dist/index.cjs');
  const esm = await import(pathToFileURL(join(packageRoot, 'dist/index.mjs')));
  assert.deepEqual(Object.keys(common).sort(), Object.keys(esm).sort());
  for (const method of ['listen', 'listenAndWatch', 'createDevServer']) assert.equal(typeof common[method], 'function');
  const cliEsm = await import(pathToFileURL(join(packageRoot, 'dist/cli.mjs')));
  const cliCommon = forkRequire('./dist/cli.cjs');
  assert.deepEqual(Object.keys(cliEsm).sort(), Object.keys(cliCommon).sort());
  const help = execFileSync(process.execPath, [join(packageRoot, 'bin/listhen.mjs'), '--help'], { encoding: 'utf8', timeout: 10000 });
  assert.match(help, /listhen/);
  assert.match(help, /https/);
});

test('published listener certificate union remains assignable to Node HTTPS options', async () => {
  const ts = applicationRequire('typescript');
  const filename = join(repository, 'apps/frontend/listhen-security-contract.ts');
  const declarations = ts.createSourceFile('certificate-contract.d.ts', await readFile(join(packageRoot, 'dist/shared/listhen.Dh3trXcM.d.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const interfaces = new Map(declarations.statements.filter(ts.isInterfaceDeclaration).map(node => [node.name.text, node]));
  const httpsProperty = interfaces.get('Listener').members.find(node => node.name?.getText() === 'https');
  // Check the changed published contract without type-checking unrelated upstream adapters.
  const source = `
    import type { ServerOptions } from 'node:https';
    ${interfaces.get('Certificate').getText()}
    ${interfaces.get('PfxCertificate').getText()}
    declare const listener: { https: ${httpsProperty.type.getText()} };
    const certificate: Certificate = { key: 'PEM', cert: 'PEM' };
    const serverOptions: ServerOptions = certificate;
    if (listener.https) {
      const tlsOptions: ServerOptions = listener.https;
      void tlsOptions;
    }
    void serverOptions;
  `;
  const options = {
    noEmit: true, strict: true,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022,
    types: ['node'], typeRoots: [dirname(dirname(applicationRequire.resolve('@types/node/package.json')))],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, ...rest) => path === filename
    ? ts.createSourceFile(path, source, languageVersion, true)
    : getSourceFile(path, languageVersion, ...rest);
  const program = ts.createProgram([filename], options, host);
  const errors = ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});

test('CA-signed certificates preserve SANs, validity, key usage and native signature verification', () => {
  const ca = new X509Certificate(generated.ca.cert);
  const cert = new X509Certificate(generated.cert.cert);
  assert.equal(ca.ca, true);
  assert.equal(cert.ca, false);
  assert.notEqual(ca.subject, cert.subject);
  assert(cert.verify(ca.publicKey));
  assert(ca.verify(ca.publicKey));
  assert(cert.checkPrivateKey(createPrivateKey(generated.cert.key)));
  assert.equal(cert.publicKey.asymmetricKeyDetails.modulusLength, 2048);
  assert.equal(cert.checkHost('localhost'), 'localhost');
  assert.equal(cert.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(cert.checkIP('::1'), '::1');
  assert.equal(cert.checkHost('untrusted.example'), undefined);
  assert(cert.keyUsage.includes('1.3.6.1.5.5.7.3.1'));
  assert(cert.keyUsage.includes('1.3.6.1.5.5.7.3.2'));
  const expectedExpiry = new Date(cert.validFrom);
  expectedExpiry.setDate(expectedExpiry.getDate() + 2);
  assert.equal(Date.parse(cert.validTo), expectedExpiry.getTime());
});

test('encrypted leaf and CA keys use native PKCS8 and reject incorrect passphrases', async () => {
  const result = await certificates.generateCertificates({ passphrase: 'leaf-test-password', signingKeyPassphrase: 'ca-test-password' });
  assert.match(result.cert.key, /BEGIN ENCRYPTED PRIVATE KEY/);
  assert.match(result.ca.key, /BEGIN ENCRYPTED PRIVATE KEY/);
  assert.throws(() => createPrivateKey({ key: result.ca.key, passphrase: 'wrong' }));
  assert.throws(() => createPrivateKey({ key: result.cert.key, passphrase: 'wrong' }));
  assert(new X509Certificate(result.cert.cert).checkPrivateKey(createPrivateKey({ key: result.cert.key, passphrase: 'leaf-test-password' })));
  await withListener({ https: result.cert }, async listener => {
    assert.equal((await request(listener.url, { ca: result.ca.cert })).body, 'secure response');
  });
  await assert.rejects(certificates.generateTLSCert({
    signingKey: result.ca.key, signingKeyCert: result.ca.cert, signingKeyPassphrase: 'wrong', domains: ['localhost'],
  }));
});

test('HTTP listener closes idempotently', async () => {
  let listener;
  await withListener({}, async current => {
    listener = current;
    assert.equal(await (await fetch(current.url)).text(), 'secure response');
    assert.equal(current.https, false);
  });
  await listener.close();
  assert.equal(listener.server.listening, false);
});

test('HTTPS accepts PEM values and file paths without disabling certificate validation', async () => {
  for (const options of [generated.cert, { key: join(directory, 'key.pem'), cert: join(directory, 'cert.pem') }]) {
    await withListener({ https: options }, async listener => {
      assert.deepEqual(await request(listener.url, { ca: generated.ca.cert }), { status: 200, body: 'secure response' });
      await assert.rejects(request(listener.url));
    });
  }
  await assert.rejects(certificates.resolveCertificate({ key: join(directory, 'missing.key'), cert: join(directory, 'cert.pem') }), { code: 'ENOENT' });
});

test('automatic HTTPS certificate generation remains available', async () => {
  await withListener({ https: true }, async listener => {
    assert.equal(new X509Certificate(listener.https.cert).checkHost('localhost'), 'localhost');
    assert.match(listener.url, /^https:/);
  });
});

test('PFX stores are validated by native TLS, including encrypted stores and error paths', async () => {
  for (const passphrase of ['', 'pfx-test-password']) {
    const path = join(directory, passphrase ? 'encrypted.p12' : 'plain.p12');
    execFileSync('openssl', ['pkcs12', '-export', '-inkey', join(directory, 'key.pem'), '-in', join(directory, 'cert.pem'), '-out', path, '-passout', `pass:${passphrase}`], { timeout: 10000 });
    await withListener({ https: { pfx: path, passphrase } }, async listener => {
      assert(Buffer.isBuffer(listener.https.pfx));
      assert.deepEqual(await request(listener.url, { ca: generated.ca.cert }), { status: 200, body: 'secure response' });
    });
    await assert.rejects(certificates.resolveCertificate({ pfx: path, passphrase: 'incorrect' }));
  }
  await writeFile(join(directory, 'invalid.p12'), 'not a PKCS12 store');
  await assert.rejects(certificates.resolveCertificate({ pfx: join(directory, 'invalid.p12') }));
  await assert.rejects(certificates.resolveCertificate({ pfx: join(directory, 'missing.p12') }), { code: 'ENOENT' });
});

test('native TLS rejects a certificate with a corrupted signature', async () => {
  const raw = Buffer.from(new X509Certificate(generated.cert.cert).raw);
  raw[raw.length - 1] ^= 1;
  const damaged = `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  assert.equal(new X509Certificate(damaged).verify(new X509Certificate(generated.ca.cert).publicKey), false);
  await withListener({ https: { key: generated.cert.key, cert: damaged } }, async listener => {
    await assert.rejects(request(listener.url, { ca: generated.ca.cert }));
  });
});

test('native PKCS1 verifier rejects extra DigestAlgorithm ASN1 elements (CVE-2026-85393)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 3 });
  const message = Buffer.from('VigiEau security regression fixture');
  assert(verify('sha256', message, publicKey, sign('sha256', message, privateKey)));
  // Valid RSA padding around an invalid DigestInfo with an extra nested NULL.
  const digestInfo = Buffer.concat([Buffer.from('3033300f0609608648016503040201050005000420', 'hex'), createHash('sha256').update(message).digest()]);
  const encoded = Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(256 - digestInfo.length - 3, 255), Buffer.from([0]), digestInfo]);
  const signature = privateEncrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, encoded);
  assert.equal(verify('sha256', message, publicKey, signature), false);
});

test('WebSocket upgrade and message hooks still work', { timeout: 15000 }, async () => {
  await withListener({ ws: { hooks: { message(peer, message) { peer.send(message.text()); } } } }, async listener => {
    const socket = new WebSocket(listener.url.replace(/^http/, 'ws'));
    await once(socket, 'open');
    const response = once(socket, 'message');
    socket.send('echo-security-test');
    assert.equal((await response)[0].data, 'echo-security-test');
    const closed = once(socket, 'close');
    socket.close();
    await closed;
  });
});

test('watch mode reloads a changed module and releases the watcher on close', { timeout: 20000 }, async () => {
  const entry = join(directory, 'watched.ts');
  await writeFile(entry, 'export default (_req: unknown, res: any) => res.end("before")\n');
  const listener = await listenAndWatch(entry, { ...listenerOptions, cwd: directory });
  try {
    assert.equal(await (await fetch(listener.url)).text(), 'before');
    await writeFile(entry, 'export default (_req: unknown, res: any) => res.end("after")\n');
    let text;
    for (let attempt = 0; attempt < 40; attempt++) {
      text = await (await fetch(listener.url)).text();
      if (text === 'after') break;
      await delay(150);
    }
    assert.equal(text, 'after');
  } finally {
    await listener.close();
  }
  assert.equal(listener.server.listening, false);
});

for (const forceColor of ['0', '1']) {
  test(`CLI can start and stop a real HTTP listener (FORCE_COLOR=${forceColor})`, { timeout: 15000 }, async () => {
    const entry = join(directory, 'cli-handler.mjs');
    await writeFile(entry, 'export default (_req, res) => res.end("cli-response")\n');
    const env = { ...process.env, NODE_ENV: 'development', FORCE_COLOR: forceColor };
    if (forceColor === '1') delete env.NO_COLOR;
    const child = spawn(process.execPath, [join(packageRoot, 'bin/listhen.mjs'), entry, '--port', '0', '--host', '127.0.0.1', '--no-qr', '--no-clipboard'], {
      cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    try {
      let url;
      for (let attempt = 0; attempt < 60; attempt++) {
        url = stripVTControlCharacters(output).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (url) break;
        if (child.exitCode !== null) break;
        await delay(100);
      }
      assert(url, output);
      if (forceColor === '1') assert.notEqual(output, stripVTControlCharacters(output));
      assert.equal(await (await fetch(url)).text(), 'cli-response');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill('SIGTERM');
        await closed;
      }
    }
  });
}
