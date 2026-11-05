import { randomBytes, scryptSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

if (!process.argv[2]) throw new Error('Usage: node scripts/preprod-auth/create-access.mjs /private/new-directory');
const directory = resolve(process.argv[2]);
// Requiring a new directory prevents replacing any existing credential files.
await mkdir(directory, { mode: 0o700 });
const username = 'vigieau-preprod';
const password = randomBytes(24).toString('base64url');
const salt = randomBytes(16);
const digest = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const hash = ['scrypt', '16384', '8', '1', salt.toString('base64url'), digest.toString('base64url')].join('$');
const secret = randomBytes(32).toString('base64url');
await writeFile(join(directory, 'credentials.json'), JSON.stringify({ username, password }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
await writeFile(join(directory, 'public.env'),
  `VIGIEAU_PREPROD_AUTH_ENABLED=true\nVIGIEAU_PREPROD_AUTH_USERNAME=${username}\nVIGIEAU_PREPROD_AUTH_PASSWORD_HASH='${hash}'\nVIGIEAU_PREPROD_AUTH_SESSION_SECRET=${secret}\n`,
  { mode: 0o600, flag: 'wx' });
console.log(`New access files saved privately in ${directory}.`);
