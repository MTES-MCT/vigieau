import { statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export function previewAddress(env = process.env, args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { host: { type: 'string' }, port: { type: 'string' } } });
  const value = values.port || env.NUXT_PORT || env.NITRO_PORT || env.PORT || '3000';
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid preview port: ${value}`);
  }
  return { port, host: values.host || env.NUXT_HOST || env.NITRO_HOST || env.HOST || '0.0.0.0' };
}

export function staticPreview({ appDirectory = process.cwd(), publicDirectory = join(appDirectory, '.output/public') } = {}) {
  if (!statSync(join(publicDirectory, 'index.html'), { throwIfNoEntry: false })?.isFile()) {
    throw new Error('Generated index.html not found. Run npm run build before npm start.');
  }
  // Resolve the app's declared runtime dependency, including after PROJECT_DIR
  // extraction. This script is copied beside public/, outside the served tree.
  const require = createRequire(join(resolve(appDirectory), 'package.json'));
  const serve = require('sirv')(publicDirectory, {
    single: true,
    etag: true,
    gzip: true,
    brotli: true,
    ignores: [/^\/(?:_nuxt(?:\/|$)|workbox-)/],
  });
  return createServer((request, response) => {
    response.setHeader('Cache-Control', 'public, max-age=0, s-maxage=0, must-revalidate');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
      return response.end();
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      response.writeHead(400, { 'Cache-Control': 'no-store' });
      return response.end();
    }
    if (/\.map(?:\.(?:gz|br))?$/i.test(pathname) || pathname.split('/').some(part => part.startsWith('.') && part !== '.well-known')) {
      response.writeHead(404, { 'Cache-Control': 'no-store' });
      return response.end();
    }
    if (['/sw.js', '/manifest.webmanifest', '/inject-sw.js'].includes(pathname)) {
      response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (/^\/(?:_nuxt\/|workbox-)/.test(pathname)) {
      response.setHeader('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
    }
    serve(request, response, () => {
      response.writeHead(404, { 'Cache-Control': 'no-store' });
      response.end();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { host, port } = previewAddress();
  const server = staticPreview();
  server.listen(port, host, () => {
    const address = server.address();
    const hostname = address.address.includes(':') ? `[${address.address}]` : address.address;
    console.log(`Static preview listening on http://${hostname}:${address.port}`);
  });
}
