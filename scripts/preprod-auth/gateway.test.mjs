import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import {
  APP_NAMES,
  CSRF_COOKIE,
  PUBLIC_HOSTS,
  SESSION_COOKIE,
  SESSION_SECONDS,
  gatewayConfiguration,
} from "./config.mjs";
import { createGateway, safeReturnPath } from "./gateway.mjs";

const USERNAME = "synthetic-team";
const PASSWORD = "synthetic-preproduction-password";
const passwordHash = (password) => {
  const salt = Buffer.alloc(16, 21);
  const digest = scryptSync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${digest.toString("base64url")}`;
};
const HASH = passwordHash(PASSWORD);
const SECRET = Buffer.alloc(32, 37).toString("base64url");
const IP = "192.0.2.10";

class CookieJar {
  values = new Map();
  absorb(response) {
    for (const entry of response.headers["set-cookie"] || []) {
      const [pair] = entry.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      if (/;\s*Max-Age=0(?:;|$)/i.test(entry)) this.values.delete(name);
      else this.values.set(name, pair.slice(separator + 1));
    }
  }
  header() {
    return [...this.values]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

async function listening(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function fixture(t, { maxRateEntries } = {}) {
  const servers = [];
  const clock = { milliseconds: Date.UTC(2026, 10, 5, 12) };
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "public, max-age=3600",
    });
    response.end(
      JSON.stringify({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body,
      }),
    );
  });
  servers.push(upstream);
  const upstreamPort = await listening(upstream);
  t.after(async () => {
    for (const server of servers.reverse()) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  async function add(role, overrides = {}) {
    const env = {
      APP: APP_NAMES[role],
      PORT: "5000",
      SCALINGO_APPLICATION_ID: "fixture",
      VIGIEAU_PREPROD_AUTH_ENABLED: "true",
      VIGIEAU_PREPROD_AUTH_USERNAME: USERNAME,
      VIGIEAU_PREPROD_AUTH_PASSWORD_HASH: HASH,
      VIGIEAU_PREPROD_AUTH_SESSION_SECRET: SECRET,
      ...overrides,
    };
    const config = {
      ...gatewayConfiguration(env, role),
      upstream: `http://127.0.0.1:${upstreamPort}`,
    };
    const server = createGateway(config, {
      now: () => clock.milliseconds,
      maxRateEntries,
    });
    servers.push(server);
    return { port: await listening(server), host: PUBLIC_HOSTS[role] };
  }
  return {
    clock,
    add,
    front: await add("frontend"),
    api: await add("backend"),
  };
}

function call(
  gateway,
  path,
  {
    method = "GET",
    body,
    headers = {},
    jar,
    ip = IP,
    host = gateway.host,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: gateway.port,
        path,
        method,
        headers: {
          host,
          "x-real-ip": ip,
          ...headers,
          ...(jar ? { cookie: jar.header() } : {}),
        },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          const result = {
            status: response.statusCode,
            headers: response.headers,
            body,
          };
          jar?.absorb(result);
          resolve(result);
        });
      },
    );
    request.once("error", reject);
    request.setTimeout(5000, () =>
      request.destroy(new Error("Local HTTP test timed out")),
    );
    request.end(body);
  });
}

async function loginForm(
  gateway,
  { jar = new CookieJar(), rd = "/", ip = IP } = {},
) {
  const response = await call(
    gateway,
    `/_preprod/login?rd=${encodeURIComponent(rd)}`,
    { jar, ip },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers["referrer-policy"], "same-origin",
    "Native browser form POST must retain its same-origin Origin header");
  const csrf = response.body.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf, "Login form must contain a CSRF token");
  assert.equal(jar.values.get(CSRF_COOKIE), csrf);
  return { jar, csrf, rd, response };
}

function submit(
  gateway,
  form,
  {
    username = USERNAME,
    password = PASSWORD,
    origin = `https://${gateway.host}`,
    body,
    headers = {},
    jar = form.jar,
    ip = IP,
    ...options
  } = {},
) {
  return call(gateway, "/_preprod/login", {
    ...options,
    method: "POST",
    jar,
    ip,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(origin === null ? {} : { origin }),
      ...headers,
    },
    body:
      body ??
      new URLSearchParams({
        username,
        password,
        csrf: form.csrf,
        rd: form.rd,
      }).toString(),
  });
}

async function login(gateway, options = {}) {
  const form = await loginForm(gateway, options);
  const response = await submit(gateway, form, options);
  assert.equal(response.status, 303, response.body);
  assert.ok(form.jar.values.get(SESSION_COOKIE));
  return { ...form, response };
}

function unauthorized(response) {
  assert.equal(response.status, 401, response.body);
  assert.match(response.headers["content-type"], /^application\/json/);
  assert.deepEqual(JSON.parse(response.body), {
    error: "preprod_auth_required",
  });
  assert.equal(response.headers["cache-control"], "no-store");
}

test(
  "return paths reject external, encoded and authentication-loop destinations",
  { timeout: 15_000 },
  () => {
    for (const path of [
      undefined,
      "",
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example",
      "/%2f%2fevil.example",
      "/%252f%252fevil.example",
      "/%5cevil.example",
      "/%0d%0aLocation:evil",
      "/%250aevil",
      "/bad%",
      "/_preprod",
      "/_preprod/login",
      "/a/../_preprod/logout",
      "/%5fpreprod/login",
      "/%255fpreprod/login",
      "/".repeat(2049),
    ]) {
      assert.equal(safeReturnPath(path), "/", String(path));
    }
    for (const path of [
      "/abonnements?token=synthetic#details",
      "/swagger",
      "/carte?address=Paris%20centre",
    ]) {
      assert.equal(safeReturnPath(path), path);
    }
  },
);

test(
  "HTML navigation redirects to local login; API requests and Bearer-only requests fail closed",
  { timeout: 15_000 },
  async (t) => {
    const { front, api } = await fixture(t);
    for (const gateway of [front, api]) {
      unauthorized(
        await call(gateway, "/api/subscriptions", {
          headers: { authorization: "Bearer business-jwt" },
        }),
      );
      unauthorized(
        await call(gateway, "/api/subscriptions", {
          headers: { accept: "text/html", "sec-fetch-mode": "cors" },
        }),
      );
      unauthorized(
        await call(gateway, "/swagger", {
          headers: { accept: "text/html;q=0,application/json" },
        }),
      );
      const navigation = await call(gateway, "/swagger?section=1", {
        headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
      });
      assert.equal(navigation.status, 303);
      assert.equal(
        navigation.headers.location,
        "/_preprod/login?rd=%2Fswagger%3Fsection%3D1",
      );
      const alias = await call(gateway, "/swagger?section=1", {
        host: "alternate.scalingo.io",
      });
      assert.equal(alias.status, 303);
      assert.equal(
        alias.headers.location,
        `https://${gateway.host}/swagger?section=1`,
      );
    }
  },
);

test(
  "login issues a secure eight-hour cookie shared by frontend/API and preserves business requests",
  { timeout: 15_000 },
  async (t) => {
    const { front, api } = await fixture(t);
    const authenticated = await login(front, {
      rd: "/abonnements?token=synthetic",
    });
    assert.equal(
      authenticated.response.headers.location,
      "/abonnements?token=synthetic",
    );
    const cookie = authenticated.response.headers["set-cookie"].find((value) =>
      value.startsWith(`${SESSION_COOKIE}=`),
    );
    for (const part of [
      "Domain=vigieau.incubateur.net",
      "Path=/",
      "Max-Age=28800",
      "Secure",
      "HttpOnly",
      "SameSite=Lax",
    ])
      assert.ok(cookie.includes(part));
    assert.equal(authenticated.jar.values.has(CSRF_COOKIE), false);
    const headers = {
      authorization: "Bearer subscription-jwt",
      "x-vigieau-preprod-rate-key": "A".repeat(43),
      x_vigieau_preprod_rate_key: "B".repeat(43),
      "x-forwarded-email": "spoofed@example.test",
      x_forwarded_email: "spoofed@example.test",
      "x-auth-request-user": "attacker",
      x_auth_request_user: "attacker",
      forwarded: "for=attacker",
      "content-type": "application/json",
    };
    for (const gateway of [front, api]) {
      const response = await call(gateway, "/api/subscriptions?test=1", {
        method: "POST",
        jar: authenticated.jar,
        headers,
        body: '{"example":true}',
      });
      assert.equal(response.status, 200);
      const received = JSON.parse(response.body);
      assert.equal(received.headers.authorization, headers.authorization);
      assert.equal(received.url, "/api/subscriptions?test=1");
      assert.equal(received.body, '{"example":true}');
      assert.match(
        received.headers["x-vigieau-preprod-rate-key"],
        /^[A-Za-z0-9_-]{43}$/,
      );
      assert.notEqual(
        received.headers["x-vigieau-preprod-rate-key"],
        headers["x-vigieau-preprod-rate-key"],
      );
      for (const key of [
        "x_vigieau_preprod_rate_key",
        "x-forwarded-email",
        "x_forwarded_email",
        "x-auth-request-user",
        "x_auth_request_user",
        "forwarded",
      ])
        assert.equal(received.headers[key], undefined);
      assert.equal(response.headers["cache-control"], "no-store");
    }
  },
);

test(
  "login rejects bad credentials, missing/forged/expired CSRF and disallowed origins",
  { timeout: 15_000 },
  async (t) => {
    const { front, clock } = await fixture(t);
    for (const credentials of [
      { password: "wrong-password" },
      { username: "wrong-user" },
    ]) {
      const form = await loginForm(front);
      const response = await submit(front, form, credentials);
      assert.equal(response.status, 401);
      assert.equal(form.jar.values.has(SESSION_COOKIE), false);
    }
    const form = await loginForm(front);
    for (const origin of [
      null,
      "",
      "null",
      "https://evil.example",
      "https://admin.vigieau.incubateur.net",
      "https://vigieau.incubateur.net.evil.example",
    ]) {
      assert.equal((await submit(front, form, { origin })).status, 403);
    }
    assert.equal((await submit(front, { ...form, csrf: "" })).status, 403);
    assert.equal(
      (await submit(front, form, { jar: new CookieJar() })).status,
      403,
    );
    const forged = `${form.csrf.slice(0, -1)}${form.csrf.endsWith("A") ? "B" : "A"}`;
    const forgedJar = new CookieJar();
    forgedJar.values.set(CSRF_COOKIE, forged);
    assert.equal(
      (await submit(front, { ...form, csrf: forged }, { jar: forgedJar }))
        .status,
      403,
    );
    clock.milliseconds += 601_000;
    assert.equal((await submit(front, form)).status, 403);
  },
);

test(
  "login enforces the 8 KiB body limit, content type and unique credential fields",
  { timeout: 15_000 },
  async (t) => {
    const { front } = await fixture(t);
    const form = await loginForm(front);
    const base = new URLSearchParams({
      username: USERNAME,
      password: PASSWORD,
      csrf: form.csrf,
      rd: "/",
    }).toString();
    for (const field of ["username", "password", "csrf", "rd"]) {
      assert.equal(
        (await submit(front, form, { body: `${base}&${field}=duplicate` }))
          .status,
        400,
      );
    }
    assert.equal(
      (
        await submit(front, form, {
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      415,
    );
    const exact = `${base}&padding=${"x".repeat(8192 - Buffer.byteLength(base) - 9)}`;
    assert.equal(Buffer.byteLength(exact), 8192);
    assert.equal(
      (await submit(front, form, { body: `${exact}x` })).status,
      413,
    );
    assert.equal((await submit(front, form, { body: exact })).status, 303);
  },
);

test(
  "login limits ten attempts per fifteen minutes without growing past the IP table bound",
  { timeout: 15_000 },
  async (t) => {
    const { front, clock } = await fixture(t, { maxRateEntries: 2 });
    for (let attempt = 0; attempt < 10; attempt++) {
      assert.equal(
        (await submit(front, await loginForm(front), { password: "wrong" }))
          .status,
        401,
      );
    }
    const limited = await submit(front, await loginForm(front));
    assert.equal(limited.status, 429);
    assert.equal(Number(limited.headers["retry-after"]), 900);
    assert.equal(
      (
        await submit(front, await loginForm(front), {
          password: "wrong",
          ip: "192.0.2.11",
        })
      ).status,
      401,
    );
    assert.equal(
      (await submit(front, await loginForm(front), { ip: "192.0.2.12" }))
        .status,
      429,
    );
    assert.equal(
      (await submit(front, await loginForm(front), { ip: IP })).status,
      429,
    );
    clock.milliseconds += 901_000;
    await login(front, { ip: "192.0.2.12" });
  },
);

test(
  "rate keys survive relogin and relays, distinguish initial client IPs, and ignore untrusted forwarding",
  { timeout: 15_000 },
  async (t) => {
    const { front, api, add } = await fixture(t);
    const key = async (gateway, jar, ip) =>
      JSON.parse((await call(gateway, "/api/subscriptions", { jar, ip })).body)
        .headers["x-vigieau-preprod-rate-key"];
    const first = await login(front, { ip: IP });
    const firstKey = await key(front, first.jar, IP);
    assert.equal(await key(api, first.jar, "198.51.100.50"), firstKey);
    const relogin = await login(api, { ip: IP });
    assert.equal(await key(api, relogin.jar, IP), firstKey);
    const other = await login(front, { ip: "192.0.2.11" });
    assert.notEqual(await key(api, other.jar, "198.51.100.50"), firstKey);
    const local = await add("frontend", { SCALINGO_APPLICATION_ID: "" });
    const localFirst = await login(local, { ip: "192.0.2.20" });
    const localSecond = await login(local, { ip: "192.0.2.21" });
    assert.equal(
      await key(local, localFirst.jar, "192.0.2.20"),
      await key(local, localSecond.jar, "192.0.2.21"),
    );
  },
);

test(
  "expired, tampered, duplicate and revoked session cookies cannot reach the upstream",
  { timeout: 15_000 },
  async (t) => {
    const { front, api, add, clock } = await fixture(t);
    const { jar } = await login(front);
    const session = jar.values.get(SESSION_COOKIE);
    const altered = new CookieJar();
    altered.values.set(
      SESSION_COOKIE,
      `${session.slice(0, -1)}${session.endsWith("A") ? "B" : "A"}`,
    );
    unauthorized(await call(api, "/api/subscriptions", { jar: altered }));
    unauthorized(
      await call(api, "/api/subscriptions", {
        headers: {
          cookie: `${SESSION_COOKIE}=${session}; ${SESSION_COOKIE}=${session}`,
        },
      }),
    );
    for (const override of [
      { VIGIEAU_PREPROD_AUTH_USERNAME: "changed-team" },
      { VIGIEAU_PREPROD_AUTH_PASSWORD_HASH: passwordHash("changed-password") },
      {
        VIGIEAU_PREPROD_AUTH_SESSION_SECRET: Buffer.alloc(32, 38).toString(
          "base64url",
        ),
      },
    ]) {
      unauthorized(
        await call(await add("backend", override), "/api/subscriptions", {
          jar,
        }),
      );
    }
    clock.milliseconds += SESSION_SECONDS * 1000;
    unauthorized(await call(api, "/api/subscriptions", { jar }));
  },
);

test(
  "anonymous exceptions match only their role, exact path and GET method",
  { timeout: 15_000 },
  async (t) => {
    const { front, api } = await fixture(t);
    for (const [gateway, path, other] of [
      [front, "/sw.js", "/api/health/live"],
      [api, "/api/health/live", "/sw.js"],
    ]) {
      const response = await call(gateway, path);
      assert.equal(response.status, 200);
      assert.equal(
        JSON.parse(response.body).headers["x-vigieau-preprod-rate-key"],
        undefined,
      );
      for (const invalid of [
        other,
        `${path}/`,
        `${path}/extra`,
        path.replace("/", "/%2f"),
      ])
        unauthorized(await call(gateway, invalid));
      for (const method of ["POST", "PUT", "OPTIONS"])
        unauthorized(await call(gateway, path, { method }));
      assert.equal((await call(gateway, path, { method: "HEAD" })).status, 401);
    }
  },
);

test(
  "logout requires an approved origin, clears cookies, and never treats GET as a logout",
  { timeout: 15_000 },
  async (t) => {
    const { front, api } = await fixture(t);
    const { jar } = await login(front);
    for (const origin of [undefined, "https://evil.example"]) {
      assert.equal(
        (
          await call(api, "/_preprod/logout", {
            method: "POST",
            jar,
            headers: origin ? { origin } : {},
          })
        ).status,
        403,
      );
      assert.equal(
        (await call(api, "/api/subscriptions", { jar })).status,
        200,
      );
    }
    assert.equal((await call(api, "/_preprod/logout", { jar })).status, 404);
    const logout = await call(api, "/_preprod/logout", {
      method: "POST",
      jar,
      headers: { origin: `https://${front.host}` },
    });
    assert.equal(logout.status, 303);
    assert.equal(logout.headers.location, "/_preprod/login");
    assert.equal(jar.values.has(SESSION_COOKIE), false);
    unauthorized(await call(api, "/api/subscriptions", { jar }));
  },
);
