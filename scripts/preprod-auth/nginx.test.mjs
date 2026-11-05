import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Opt in: RUN_NGINX_INTEGRATION_TESTS=true node --test scripts/preprod-auth/nginx.test.mjs
// Requires Docker and openssl. Ruby is installed only inside an ephemeral container.
// After installing Ruby, its network is detached: all HTTP/TLS traffic stays local.
test(
  'real ERB and Nginx preserve preproduction relay boundaries and validate upstream TLS',
  {
    skip: process.env.RUN_NGINX_INTEGRATION_TESTS !== 'true',
    timeout: 180000,
  },
  async (t) => {
    const repository = fileURLToPath(new URL('../../', import.meta.url));
    const directory = mkdtempSync(join(tmpdir(), 'vigieau-nginx-test-'));
    const container = `vigieau-nginx-test-${process.pid}`;
    const image = process.env.NGINX_TEST_IMAGE || 'nginx:1.31.8-alpine';
    const docker = (...args) =>
      execFileSync('docker', args, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60000,
      });
    const execute = (...args) => docker('exec', container, ...args);
    const openssl = (...args) =>
      execFileSync('openssl', args, {
        cwd: directory,
        stdio: 'pipe',
        timeout: 10000,
      });
    const request = (port, path, ...args) => {
      const output = execute(
        'curl',
        '--silent',
        '--show-error',
        '--max-time',
        '5',
        '--write-out',
        '\n%{http_code}',
        ...args,
        `http://127.0.0.1:${port}${path}`,
      );
      const separator = output.lastIndexOf('\n');
      return {
        status: Number(output.slice(separator + 1)),
        body: output.slice(0, separator),
      };
    };
    const createCertificate = (name, hostname) => {
      openssl(
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${name}.key`,
        '-out',
        `${name}.csr`,
        '-subj',
        `/CN=${hostname}`,
      );
      writeFileSync(
        join(directory, `${name}.ext`),
        `subjectAltName=DNS:${hostname}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
      );
      openssl(
        'x509',
        '-req',
        '-in',
        `${name}.csr`,
        '-CA',
        'ca.pem',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-out',
        `${name}.pem`,
        '-days',
        '1',
        '-extfile',
        `${name}.ext`,
      );
    };

    try {
      mkdirSync(join(directory, 'public'));
      writeFileSync(join(directory, 'public/index.html'), 'fixture-spa');
      mkdirSync(join(directory, 'public/_nuxt'));
      for (const path of [
        '_nuxt/fixture.js',
        'workbox-fixture.js',
        'fixture.js',
      ]) {
        writeFileSync(
          join(directory, 'public', path),
          'console.log("fixture");',
        );
      }
      openssl(
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        'ca.key',
        '-out',
        'ca.pem',
        '-days',
        '1',
        '-subj',
        '/CN=VigiEau integration test CA',
      );
      createCertificate('server', 'api.vigieau.incubateur.net');
      createCertificate('wrong-name', 'wrong.example.test');
      openssl(
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        'untrusted.key',
        '-out',
        'untrusted.pem',
        '-days',
        '1',
        '-subj',
        '/CN=api.vigieau.incubateur.net',
        '-addext',
        'subjectAltName=DNS:api.vigieau.incubateur.net',
      );
      docker(
        'run',
        '--detach',
        '--name',
        container,
        '--add-host',
        'api.vigieau.incubateur.net:127.0.0.1',
        '--mount',
        `type=bind,src=${repository},dst=/repo,readonly`,
        '--mount',
        `type=bind,src=${directory},dst=/test`,
        '--mount',
        `type=bind,src=${join(directory, 'public')},dst=/app/.output/public,readonly`,
        '--entrypoint',
        'sleep',
        image,
        'infinity',
      );
      execute('apk', 'add', '--no-cache', 'ruby');
      docker('network', 'disconnect', 'bridge', container);
      execute(
        'sh',
        '-c',
        'cat /test/ca.pem >> /etc/ssl/certs/ca-certificates.crt',
      );
      execute('cp', '/etc/nginx/mime.types', '/test/mime.types');

      const profiles = [
        {
          name: 'frontend',
          app: 'preservonsleau-front-preprod',
          flag: 'VIGIEAU_PREPROD_AUTH_ENABLED',
          path: 'apps/frontend/nginx.conf.erb',
          route: '/api/',
        },
        {
          name: 'admin',
          app: 'regleau-front-preprod',
          flag: 'VIGIEAU_PREPROD_PUBLIC_API_BRIDGE',
          path: 'apps/frontend-admin/nginx.conf.erb',
          route: '/api-vigieau/',
        },
      ];
      const cases = profiles.flatMap((profile) => [
        ...[undefined, '', 'false'].map((flag, index) => ({
          name: `${profile.name}-off-${index}`,
          path: profile.path,
          env: {
            APP: 'production-app',
            [profile.flag]: flag,
            API_URL: 'http://127.0.0.1:8084',
          },
          expected: 'off',
        })),
        {
          name: `${profile.name}-on`,
          path: profile.path,
          env: {
            APP: profile.app,
            [profile.flag]: 'true',
            API_URL: 'http://127.0.0.1:8084',
          },
          expected: 'on',
        },
        {
          name: `${profile.name}-wrong-app`,
          path: profile.path,
          env: { APP: 'production-app', [profile.flag]: 'true' },
          expected: 'error',
        },
        ...['TRUE', '1', 'yes', ' true '].map((flag) => ({
          name: `${profile.name}-invalid-${flag}`,
          path: profile.path,
          env: { APP: profile.app, [profile.flag]: flag },
          expected: 'error',
        })),
      ]);
      writeFileSync(join(directory, 'cases.json'), JSON.stringify(cases));
      writeFileSync(
        join(directory, 'render.rb'),
        `require 'json'\nrequire 'erb'\nresults = JSON.parse(File.read('/test/cases.json')).map do |item|\n  ENV.clear\n  ENV.update(item['env'].compact)\n  begin\n    { name: item['name'], config: ERB.new(File.read('/repo/' + item['path'])).result }\n  rescue => error\n    { name: item['name'], error: error.message }\n  end\nend\nputs JSON.generate(results)\n`,
      );
      const rendered = JSON.parse(execute('ruby', '/test/render.rb'));
      await t.test(
        'ERB accepts only exact flags and applications and retains ordinary configurations when disabled',
        () => {
          for (const item of cases) {
            const result = rendered.find((result) => result.name === item.name);
            if (item.expected === 'error') {
              assert.ok(result.error, `${item.name} must fail closed`);
            } else {
              assert.equal(result.error, undefined, item.name);
              assert.equal(
                result.config.includes(
                  'proxy_pass https://api.vigieau.incubateur.net/api/;',
                ),
                item.expected === 'on',
                item.name,
              );
              assert.ok(
                result.config.includes('root /app/.output/public;'),
                item.name,
              );
            }
          }
        },
      );

      const configuration = (certificate = 'server') =>
        `events {}\nhttp {\naccess_log off;\nerror_log /test/error.log info;\nserver {\nlisten 443 ssl;\nserver_name api.vigieau.incubateur.net;\nssl_certificate /test/${certificate}.pem;\nssl_certificate_key /test/${certificate}.key;\nlocation = /api/unauthorized { default_type application/json; return 401 '{}'; }\nlocation / { default_type application/json; return 200 '{"uri":"$request_uri","authorization":"$http_authorization","cookie":"$http_cookie","host":"$host","tls":"$https","method":"$request_method"}'; }\n}\nserver { listen 8084; location / { default_type application/json; return 200 '{"upstream":"admin","uri":"$request_uri","authorization":"$http_authorization","cookie":"$http_cookie"}'; } }\n${[
          ['frontend-on', 8080],
          ['admin-on', 8081],
          ['frontend-off-0', 8082],
          ['admin-off-0', 8083],
        ]
          .map(
            ([name, port]) =>
              `server { listen ${port};\n${rendered.find((result) => result.name === name).config}\n}`,
          )
          .join('\n')}\n}\n`;
      writeFileSync(join(directory, 'nginx.conf'), configuration());
      await t.test('both enabled and disabled templates pass nginx -t', () => {
        assert.match(execute('nginx', '-t', '-c', '/test/nginx.conf'), /^$/);
      });
      execute('nginx', '-c', '/test/nginx.conf');

      await t.test(
        'both relays preserve paths, query strings, cookies and the business bearer over verified TLS',
        () => {
          for (const [port, route] of [
            [8080, '/api/'],
            [8081, '/api-vigieau/'],
          ]) {
            const result = request(
              port,
              `${route}zones?commune=47001&token=fixture`,
              '--header',
              'Cookie: __Secure-vigieau_preprod_auth=fixture-session; admin_session=fixture-admin',
              '--header',
              'Authorization: Bearer business-fixture',
              '--request',
              'POST',
              '--data',
              'fixture=request',
            );
            assert.equal(result.status, 200, result.body);
            assert.deepEqual(JSON.parse(result.body), {
              uri: '/api/zones?commune=47001&token=fixture',
              authorization: 'Bearer business-fixture',
              cookie:
                '__Secure-vigieau_preprod_auth=fixture-session; admin_session=fixture-admin',
              host: 'api.vigieau.incubateur.net',
              tls: 'on',
              method: 'POST',
            });
            const unauthorized = request(port, `${route}unauthorized`);
            assert.equal(unauthorized.status, 401);
            assert.deepEqual(JSON.parse(unauthorized.body), {});
          }
        },
      );

      await t.test(
        'the admin application and its own API remain outside the public relay',
        () => {
          assert.equal(request(8081, '/arrete-municipal').body, 'fixture-spa');
          for (const port of [8081, 8083]) {
            const response = request(
              port,
              '/api/user/me',
              '--header',
              'Authorization: Bearer admin-fixture',
              '--header',
              'Cookie: admin_session=fixture',
            );
            assert.deepEqual(JSON.parse(response.body), {
              upstream: 'admin',
              uri: '/api/user/me',
              authorization: 'Bearer admin-fixture',
              cookie: 'admin_session=fixture',
            });
          }
          assert.equal(request(8082, '/api/zones').body, 'fixture-spa');
        },
      );

      await t.test(
        'private frontend shell and scripts disable caches while ordinary builds retain existing cache headers',
        () => {
          for (const path of [
            '/',
            '/_nuxt/fixture.js',
            '/workbox-fixture.js',
            '/fixture.js',
          ]) {
            const protectedHeaders = execute(
              'curl',
              '--silent',
              '--show-error',
              '--head',
              `http://127.0.0.1:8080${path}`,
            );
            assert.match(protectedHeaders, /Cache-Control: no-store/i, path);
            assert.doesNotMatch(
              protectedHeaders,
              /Cache-Control: public/i,
              path,
            );
            const ordinaryHeaders = execute(
              'curl',
              '--silent',
              '--show-error',
              '--head',
              `http://127.0.0.1:8082${path}`,
            );
            assert.match(ordinaryHeaders, /Cache-Control: public/i, path);
          }
        },
      );

      for (const [certificate, expectedError] of [
        ['wrong-name', /certificate does not match/],
        ['untrusted', /certificate verify error/],
      ]) {
        await t.test(
          `both relays reject the ${certificate} upstream certificate`,
          async () => {
            writeFileSync(
              join(directory, 'nginx.conf'),
              configuration(certificate),
            );
            execute('nginx', '-s', 'reload', '-c', '/test/nginx.conf');
            for (const [port, route] of [
              [8080, '/api/'],
              [8081, '/api-vigieau/'],
            ]) {
              let response;
              for (let attempt = 0; attempt < 20; attempt++) {
                response = request(port, `${route}zones`);
                if (response.status === 502) break;
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
              assert.equal(response.status, 502);
            }
            assert.match(
              readFileSync(join(directory, 'error.log'), 'utf8'),
              expectedError,
            );
          },
        );
      }
    } finally {
      try {
        docker('rm', '--force', container);
      } catch {
        /* May not have been created. */
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
