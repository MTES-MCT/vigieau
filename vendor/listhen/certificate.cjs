'use strict';

const { createPrivateKey } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { isIP } = require('node:net');
const { createSecureContext } = require('node:tls');
const { generate } = require('selfsigned');

const defaults = Object.freeze({
  commonName: 'localhost',
  countryCode: 'US',
  state: 'Michigan',
  locality: 'Berkley',
  organization: 'Testing Corp',
  organizationalUnit: 'IT department',
  domains: ['localhost', '127.0.0.1', '::1'],
  validityDays: 1,
  bits: 2048,
});

function attributes(options) {
  return [
    ['commonName', options.commonName],
    ['countryName', options.countryCode],
    ['ST', options.state],
    ['localityName', options.locality],
    ['organizationName', options.organization],
    ['OU', options.organizationalUnit],
    ['1.2.840.113549.1.9.1', options.emailAddress],
  ].filter(([, value]) => value).map(([name, value]) => ({ name, value }));
}

function validity(options) {
  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate);
  notAfterDate.setDate(notAfterDate.getDate() + (options.validityDays || 1));
  return { notBeforeDate, notAfterDate };
}

function encryptedKey(privateKey, passphrase) {
  if (passphrase === undefined) return { key: privateKey };
  if (typeof passphrase !== 'string' || passphrase.length >= 2000) {
    throw new TypeError('Certificate passphrase must be a string shorter than 2000 characters');
  }
  return {
    key: createPrivateKey(privateKey).export({
      type: 'pkcs8',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase,
    }),
    passphrase,
  };
}

async function generateCACert(options = {}) {
  const pems = await generate(attributes(options), {
    keySize: options.bits || 2048,
    algorithm: 'sha256',
    ...validity(options),
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, critical: true },
    ],
  });
  return { ...encryptedKey(pems.private, options.passphrase), cert: pems.cert };
}

async function generateTLSCert(options) {
  const domains = options.domains?.length ? options.domains : ['localhost.local'];
  const signingKey = createPrivateKey({
    key: options.signingKey,
    passphrase: options.signingKeyPassphrase,
  }).export({ type: 'pkcs8', format: 'pem' });
  const pems = await generate(attributes({ ...options, commonName: options.commonName || domains[0] }), {
    keySize: options.bits || 2048,
    algorithm: 'sha256',
    ...validity(options),
    ca: { key: signingKey, cert: options.signingKeyCert },
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
      {
        name: 'subjectAltName',
        altNames: domains.map(domain => isIP(domain)
          ? { type: 7, ip: domain }
          : { type: 2, value: domain }),
      },
    ],
  });
  return { ...encryptedKey(pems.private, options.passphrase), cert: pems.cert };
}

async function generateCertificates(input = {}) {
  const options = { ...defaults };
  for (const [key, value] of Object.entries(input || {})) {
    if (value !== undefined && value !== null) options[key] = value;
  }
  // A distinct issuer name lets OpenSSL distinguish the CA from its leaf.
  const ca = await generateCACert({
    ...options,
    commonName: `${options.commonName} Development CA`,
    passphrase: options.signingKeyPassphrase,
  });
  const cert = await generateTLSCert({
    ...options,
    domains: Array.isArray(options.domains) ? options.domains : defaults.domains,
    signingKey: ca.key,
    signingKeyCert: ca.cert,
  });
  return { ca, cert };
}

async function resolveCertificate(options = {}) {
  if (options && options.key && options.cert) {
    const pem = value => value.startsWith('--') ? value : readFile(value, 'utf8');
    const result = { key: await pem(options.key), cert: await pem(options.cert) };
    if (options.passphrase !== undefined) result.passphrase = options.passphrase;
    return result;
  }
  if (options && options.pfx) {
    const result = { pfx: await readFile(options.pfx) };
    if (options.passphrase !== undefined) result.passphrase = options.passphrase;
    // OpenSSL validates the complete PKCS#12 store, without a JavaScript decoder.
    createSecureContext(result);
    return result;
  }
  return (await generateCertificates(options)).cert;
}

module.exports = { resolveCertificate, generateCertificates, generateCACert, generateTLSCert };
