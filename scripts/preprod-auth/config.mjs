import { createHash } from "node:crypto";

export const APP_NAMES = Object.freeze({
  frontend: "preservonsleau-front-preprod",
  backend: "vigieau-api-preprod",
});
export const PUBLIC_HOSTS = Object.freeze({
  frontend: "vigieau.incubateur.net",
  backend: "api.vigieau.incubateur.net",
});
export const SESSION_COOKIE = "__Secure-vigieau_preprod_auth";
export const CSRF_COOKIE = "__Secure-vigieau_preprod_csrf";
export const SESSION_SECONDS = 8 * 60 * 60;
export const CSRF_SECONDS = 10 * 60;
export const GATEWAY_VERSION = 1;

export function booleanSetting(value, name) {
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be true or false`);
}

export function profile(env, role) {
  if (!APP_NAMES[role]) throw new Error("Unknown public application role");
  const enabled = booleanSetting(
    env.VIGIEAU_PREPROD_AUTH_ENABLED,
    "VIGIEAU_PREPROD_AUTH_ENABLED",
  );
  if (enabled && env.APP !== APP_NAMES[role])
    throw new Error(
      "Preproduction authentication is forbidden on this application",
    );
  return { enabled };
}

function canonicalBytes(value, length, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error(`${name} has an invalid encoding`);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== length || bytes.toString("base64url") !== value)
    throw new Error(`${name} has an invalid encoding`);
  return bytes;
}

export function gatewayConfiguration(env, role) {
  if (!profile(env, role).enabled)
    throw new Error("Preproduction authentication is not enabled");
  const username = env.VIGIEAU_PREPROD_AUTH_USERNAME;
  if (
    typeof username !== "string" ||
    !username ||
    username.length > 128 ||
    username.trim() !== username ||
    /[\x00-\x1f\x7f]/.test(username)
  ) {
    throw new Error(
      "VIGIEAU_PREPROD_AUTH_USERNAME is required and must be a valid username",
    );
  }
  const encodedHash = env.VIGIEAU_PREPROD_AUTH_PASSWORD_HASH;
  const parts = typeof encodedHash === "string" ? encodedHash.split("$") : [];
  if (parts.length !== 6 || parts.slice(0, 4).join("$") !== "scrypt$16384$8$1")
    throw new Error("VIGIEAU_PREPROD_AUTH_PASSWORD_HASH has an invalid format");
  const salt = canonicalBytes(parts[4], 16, "Password salt");
  const digest = canonicalBytes(parts[5], 64, "Password digest");
  const sessionSecret = canonicalBytes(
    env.VIGIEAU_PREPROD_AUTH_SESSION_SECRET,
    32,
    "VIGIEAU_PREPROD_AUTH_SESSION_SECRET",
  );
  const port = Number(env.PORT);
  if (
    typeof env.PORT !== "string" ||
    String(port) !== env.PORT ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    port === 8080
  )
    throw new Error("A public PORT different from 8080 is required");
  return Object.freeze({
    role,
    publicHost: PUBLIC_HOSTS[role],
    port,
    upstream: "http://127.0.0.1:8080",
    username,
    password: { salt, digest },
    sessionSecret,
    credentialVersion: createHash("sha256")
      .update(`${username}\0${encodedHash}`)
      .digest("base64url"),
    trustScalingoRouter: Boolean(env.SCALINGO_APPLICATION_ID),
  });
}
