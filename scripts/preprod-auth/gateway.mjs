import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CSRF_COOKIE,
  CSRF_SECONDS,
  PUBLIC_HOSTS,
  SESSION_COOKIE,
  SESSION_SECONDS,
  gatewayConfiguration,
} from "./config.mjs";

const derive = promisify(scrypt);
const LOGIN = "/_preprod/login";
const LOGOUT = "/_preprod/logout";
const LIMIT_WINDOW_MS = 15 * 60_000;
const MAX_LOGIN_BODY = 8 * 1024;
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const htmlEscape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const equals = (left, right) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function safeReturnPath(value) {
  if (typeof value !== "string" || value.length > 2048) return "/";
  let decoded = value;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (
      !decoded.startsWith("/") ||
      decoded.startsWith("//") ||
      /[\\\x00-\x1f\x7f]/.test(decoded)
    )
      return "/";
    let parsed;
    try {
      parsed = new URL(decoded, "https://local.invalid");
    } catch {
      return "/";
    }
    if (
      parsed.origin !== "https://local.invalid" ||
      parsed.pathname.startsWith("//") ||
      /^\/_preprod(?:\/|$)/i.test(parsed.pathname)
    )
      return "/";
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return "/";
    }
    if (next === decoded) return value;
    decoded = next;
  }
  return "/";
}

function cookieValue(request, name) {
  const entries = (request.headers.cookie || "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${name}=`));
  return entries.length === 1 ? entries[0].slice(name.length + 1) : null;
}

function setCookie(response, name, value, seconds) {
  const cookie = `${name}=${value}; Domain=vigieau.incubateur.net; Path=/; Max-Age=${seconds}; Secure; HttpOnly; SameSite=Lax`;
  response.setHeader("set-cookie", [
    ...(response.getHeader("set-cookie") || []),
    cookie,
  ]);
}

function noStore(response) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("pragma", "no-cache");
  response.setHeader("x-content-type-options", "nosniff");
  // no-referrer makes browsers send Origin:null on a native form POST,
  // which our strict login Origin check correctly refuses.
  response.setHeader("referrer-policy", "same-origin");
}

function json(response, status, body) {
  noStore(response);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    if (
      !/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(
        request.headers["content-type"] || "",
      )
    ) {
      request.resume();
      return reject(
        Object.assign(new Error("Unsupported content type"), { status: 415 }),
      );
    }
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_LOGIN_BODY) {
        cleanup();
        request.resume();
        reject(Object.assign(new Error("Body too large"), { status: 413 }));
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolveBody(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
  });
}

export function createGateway(
  configuration,
  { now = Date.now, maxRateEntries = 10_000 } = {},
) {
  const config = configuration;
  const limits = new Map();
  let lastPrune = 0;
  const seconds = () => Math.floor(now() / 1000);
  const mac = (purpose, value) =>
    createHmac("sha256", config.sessionSecret)
      .update(`${purpose}\0${value}`)
      .digest("base64url");
  const signed = (purpose, payload) => {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${mac(purpose, encoded)}`;
  };
  const verified = (purpose, token) => {
    if (typeof token !== "string" || token.length > 2048) return null;
    const parts = token.split(".");
    if (
      parts.length !== 2 ||
      parts[1].length !== 43 ||
      !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
      !equals(parts[1], mac(purpose, parts[0]))
    )
      return null;
    try {
      return JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    } catch {
      return null;
    }
  };
  const session = (request) => {
    const data = verified("session", cookieValue(request, SESSION_COOKIE));
    if (
      !data ||
      data.sub !== config.username ||
      data.version !== config.credentialVersion ||
      !Number.isInteger(data.iat) ||
      !Number.isInteger(data.exp) ||
      data.iat < 0 ||
      data.iat > seconds() + 30 ||
      data.exp <= seconds() ||
      data.exp > data.iat + SESSION_SECONDS ||
      typeof data.rateKey !== "string" ||
      data.rateKey.length !== 43 ||
      !/^[A-Za-z0-9_-]+$/.test(data.rateKey)
    )
      return null;
    return data;
  };
  const clientIP = (request) => {
    const header = request.headers["x-real-ip"];
    if (
      config.trustScalingoRouter &&
      typeof header === "string" &&
      isIP(header)
    )
      return header.toLowerCase();
    return request.socket.remoteAddress || "unknown";
  };
  const rateKey = (request) => mac("rate", clientIP(request));
  const loginAllowed = (request) => {
    const timestamp = now();
    if (timestamp - lastPrune > 60_000) {
      for (const [key, entry] of limits)
        if (entry.until <= timestamp) limits.delete(key);
      lastPrune = timestamp;
    }
    const key = rateKey(request);
    let entry = limits.get(key);
    if (entry && entry.until <= timestamp) {
      limits.delete(key);
      entry = null;
    }
    if (!entry) {
      if (limits.size >= maxRateEntries) return { allowed: false, retry: 60 };
      entry = { count: 0, until: timestamp + LIMIT_WINDOW_MS };
      limits.set(key, entry);
    }
    entry.count++;
    return {
      allowed: entry.count <= 10,
      retry: Math.max(1, Math.ceil((entry.until - timestamp) / 1000)),
    };
  };
  const validOrigin = (request) =>
    Object.values(PUBLIC_HOSTS).some(
      (host) => request.headers.origin === `https://${host}`,
    );
  const loginPage = (response, rd, error = "", status = 200) => {
    const time = seconds();
    const csrf = signed("csrf", {
      nonce: randomBytes(32).toString("base64url"),
      iat: time,
      exp: time + CSRF_SECONDS,
      version: config.credentialVersion,
    });
    noStore(response);
    setCookie(response, CSRF_COOKIE, csrf, CSRF_SECONDS);
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(
      `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Accès à la préproduction VigiEau</title><style>body{font:1rem system-ui;background:#f5f5fe;color:#161616;margin:0;padding:3rem 1rem}main{max-width:28rem;margin:auto;background:white;padding:2rem;border-top:4px solid #000091}h1{font-size:1.5rem}label{display:block;margin-top:1.2rem}input{box-sizing:border-box;width:100%;font:inherit;padding:.6rem}button{margin-top:1.5rem;background:#000091;color:white;border:0;padding:.8rem 1.2rem;font:inherit;cursor:pointer}.error{color:#b34000}</style><main><h1>Préproduction VigiEau</h1><p>Saisissez les identifiants de l’équipe pour accéder à cet environnement.</p>${error ? `<p class="error" role="alert">${htmlEscape(error)}</p>` : ""}<form method="post" action="${LOGIN}"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="rd" value="${htmlEscape(rd)}"><label for="username">Identifiant</label><input id="username" name="username" autocomplete="username" maxlength="128" required><label for="password">Mot de passe</label><input id="password" type="password" name="password" autocomplete="current-password" required><button type="submit">Se connecter</button></form></main></html>`,
    );
  };
  const proxy = (request, response, authenticated) => {
    const headers = {};
    const connectionHeaders = new Set(
      (request.headers.connection || "")
        .toLowerCase()
        .split(",")
        .map((name) => name.trim()),
    );
    for (const [name, value] of Object.entries(request.headers)) {
      const normalized = name.replaceAll("_", "-").toLowerCase();
      if (
        HOP_HEADERS.has(normalized) ||
        connectionHeaders.has(normalized) ||
        normalized.startsWith("x-forwarded-") ||
        normalized.startsWith("x-auth-request-") ||
        normalized.startsWith("x-vigieau-preprod-") ||
        normalized === "x-real-ip" ||
        normalized === "forwarded"
      )
        continue;
      headers[name] = value;
    }
    headers.host = config.publicHost;
    headers["x-forwarded-host"] = config.publicHost;
    headers["x-forwarded-proto"] = "https";
    headers["x-forwarded-for"] = clientIP(request);
    headers["x-real-ip"] = clientIP(request);
    if (authenticated)
      headers["x-vigieau-preprod-rate-key"] = authenticated.rateKey;
    const target = new URL(config.upstream);
    const outgoing = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: request.url,
        method: request.method,
        headers,
      },
      (incoming) => {
        const responseHeaders = {};
        const connection = new Set(
          (incoming.headers.connection || "")
            .toLowerCase()
            .split(",")
            .map((name) => name.trim()),
        );
        for (const [name, value] of Object.entries(incoming.headers))
          if (!HOP_HEADERS.has(name) && !connection.has(name))
            responseHeaders[name] = value;
        responseHeaders["cache-control"] = "no-store";
        response.writeHead(incoming.statusCode, responseHeaders);
        incoming.pipe(response);
      },
    );
    outgoing.on("error", () => {
      if (!response.headersSent)
        json(response, 502, { error: "preprod_upstream_unavailable" });
      else response.destroy();
    });
    request.on("aborted", () => outgoing.destroy());
    response.on("close", () => {
      if (!response.writableFinished) outgoing.destroy();
    });
    request.pipe(outgoing);
  };

  const server = createServer(async (request, response) => {
    try {
      if (
        !request.url?.startsWith("/") ||
        request.url.startsWith("//") ||
        /[\\\x00-\x1f\x7f]/.test(request.url)
      )
        return json(response, 400, { error: "invalid_request" });
      const rawPath = request.url.split("?")[0];
      const url = new URL(request.url, `https://${config.publicHost}`);
      const anonymousPath =
        config.role === "frontend" ? "/sw.js" : "/api/health/live";
      if (request.method === "GET" && rawPath === anonymousPath)
        return proxy(request, response, null);
      const host = request.headers.host?.toLowerCase();
      if (host !== config.publicHost && host !== `${config.publicHost}:443`) {
        noStore(response);
        response.writeHead(303, {
          location: `https://${config.publicHost}${safeReturnPath(request.url)}`,
        });
        return response.end();
      }
      if (rawPath === LOGIN && request.method === "GET")
        return loginPage(response, safeReturnPath(url.searchParams.get("rd")));
      if (rawPath === LOGIN && request.method === "POST") {
        if (!validOrigin(request))
          return json(response, 403, { error: "invalid_origin" });
        const limit = loginAllowed(request);
        if (!limit.allowed) {
          response.setHeader("retry-after", String(limit.retry));
          return json(response, 429, { error: "too_many_login_attempts" });
        }
        const form = await readBody(request);
        if (
          ["csrf", "username", "password", "rd"].some(
            (key) => form.getAll(key).length > 1,
          )
        )
          return json(response, 400, { error: "invalid_request" });
        const csrf = form.get("csrf");
        const csrfCookie = cookieValue(request, CSRF_COOKIE);
        const claim = verified("csrf", csrf);
        if (
          !csrf ||
          !csrfCookie ||
          !equals(csrf, csrfCookie) ||
          !claim ||
          claim.version !== config.credentialVersion ||
          !Number.isInteger(claim.iat) ||
          !Number.isInteger(claim.exp) ||
          claim.iat > seconds() + 30 ||
          claim.exp <= seconds() ||
          claim.exp > claim.iat + CSRF_SECONDS
        )
          return json(response, 403, { error: "invalid_csrf" });
        const username = form.get("username") || "";
        const password = form.get("password") || "";
        if (username.length > 128 || Buffer.byteLength(password) > 1024)
          return json(response, 400, { error: "invalid_request" });
        const digest = await derive(password, config.password.salt, 64, {
          N: 16384,
          r: 8,
          p: 1,
          maxmem: 64 * 1024 * 1024,
        });
        const validPassword = timingSafeEqual(digest, config.password.digest);
        const validUsername = timingSafeEqual(
          createHash("sha256").update(username).digest(),
          createHash("sha256").update(config.username).digest(),
        );
        const rd = safeReturnPath(form.get("rd"));
        if (!validPassword || !validUsername)
          return loginPage(
            response,
            rd,
            "Identifiant ou mot de passe incorrect.",
            401,
          );
        const time = seconds();
        noStore(response);
        setCookie(
          response,
          SESSION_COOKIE,
          signed("session", {
            sub: config.username,
            version: config.credentialVersion,
            iat: time,
            exp: time + SESSION_SECONDS,
            rateKey: rateKey(request),
          }),
          SESSION_SECONDS,
        );
        setCookie(response, CSRF_COOKIE, "", 0);
        response.writeHead(303, { location: rd });
        return response.end();
      }
      if (rawPath === LOGOUT && request.method === "POST") {
        if (!validOrigin(request))
          return json(response, 403, { error: "invalid_origin" });
        noStore(response);
        setCookie(response, SESSION_COOKIE, "", 0);
        setCookie(response, CSRF_COOKIE, "", 0);
        response.writeHead(303, { location: LOGIN });
        return response.end();
      }
      if (rawPath === "/_preprod" || rawPath.startsWith("/_preprod/"))
        return json(response, 404, { error: "not_found" });
      const authenticated = session(request);
      if (authenticated) return proxy(request, response, authenticated);
      noStore(response);
      const acceptsHTML = (request.headers.accept || "")
        .split(",")
        .some(
          (value) =>
            /^\s*text\/html(?:\s*;|\s*$)/i.test(value) &&
            !/;\s*q=0(?:\.0*)?(?:\s*;|\s*$)/i.test(value),
        );
      if (
        acceptsHTML &&
        (!request.headers["sec-fetch-mode"] ||
          request.headers["sec-fetch-mode"] === "navigate")
      ) {
        response.writeHead(303, {
          location: `${LOGIN}?rd=${encodeURIComponent(safeReturnPath(request.url))}`,
        });
        return response.end();
      }
      return json(response, 401, { error: "preprod_auth_required" });
    } catch (error) {
      if (!response.headersSent)
        json(response, error.status || 500, {
          error: error.status ? "invalid_request" : "preprod_gateway_error",
        });
      else response.destroy();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 256;
  return server;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const config = gatewayConfiguration(process.env, process.argv[2]);
    const server = createGateway(config);
    server.on("error", () => {
      console.error("Preproduction gateway failed to listen");
      process.exitCode = 1;
    });
    server.listen(config.port, "0.0.0.0");
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => {
        server.close();
        server.closeIdleConnections();
      });
  } catch (error) {
    console.error(
      `Preproduction gateway configuration rejected: ${error.message}`,
    );
    process.exitCode = 1;
  }
}
