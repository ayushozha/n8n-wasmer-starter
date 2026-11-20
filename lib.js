'use strict';
// Pure helpers for server.js, kept separate so they can be unit-tested without n8n or Postgres.

const crypto = require('node:crypto');

/** Map Wasmer's managed-database variables (DB_HOST, ...) onto n8n's DB_POSTGRESDB_* names. */
function n8nDatabaseEnv(env) {
  if (env.DB_POSTGRESDB_HOST || !env.DB_HOST) return {};
  const ssl = (env.WASMER_N8N_DB_SSL ?? 'true') !== 'false';
  return {
    DB_TYPE: 'postgresdb',
    DB_POSTGRESDB_HOST: env.DB_HOST,
    DB_POSTGRESDB_PORT: env.DB_PORT ?? '5432',
    DB_POSTGRESDB_DATABASE: env.DB_NAME,
    DB_POSTGRESDB_USER: env.DB_USERNAME,
    DB_POSTGRESDB_PASSWORD: env.DB_PASSWORD,
    // Wasmer databases require TLS but use a private CA, so verify nothing beyond encryption.
    ...(ssl && { DB_POSTGRESDB_SSL_ENABLED: 'true', DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED: 'false' }),
  };
}

/** Connection options for `pg`, read back from the n8n variables so both use the same database. */
function pgOptions(env) {
  return {
    host: env.DB_POSTGRESDB_HOST,
    port: Number(env.DB_POSTGRESDB_PORT ?? 5432),
    database: env.DB_POSTGRESDB_DATABASE,
    user: env.DB_POSTGRESDB_USER,
    password: env.DB_POSTGRESDB_PASSWORD,
    ssl: env.DB_POSTGRESDB_SSL_ENABLED === 'true'
      ? { rejectUnauthorized: env.DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : undefined,
  };
}

/** Fresh per-instance secrets. The password satisfies n8n's policy (8-64 chars, a digit, an uppercase letter). */
function newSecrets() {
  return {
    encryption_key: crypto.randomBytes(32).toString('base64url'),
    owner_email: 'owner@n8n.wasmer.app',
    owner_password: `${crypto.randomBytes(24).toString('base64url')}A1`,
  };
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
      const i = p.indexOf('=');
      return i < 0 ? [p, ''] : [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
    }),
  );
}

/**
 * The path n8n (Express) will actually route a request URL to: dot segments resolved, repeated
 * slashes collapsed, trailing slash dropped. Every access decision uses this, never the raw URL,
 * so variants like `//rest/owner/setup/` or `/a/../rest/owner/setup` can't slip past a check.
 */
function parseRequestUrl(url) {
  // Collapse repeated slashes first: `new URL('//host/x', base)` would read `host` as a hostname.
  const q = url.indexOf('?');
  const [rawPath, rawSearch] = q < 0 ? [url, ''] : [url.slice(0, q), url.slice(q)];
  try {
    return new URL(rawPath.replace(/[/\\]{2,}/g, '/') + rawSearch, 'http://localhost');
  } catch {
    return new URL('/', 'http://localhost');
  }
}

function canonicalPath(url) {
  const path = parseRequestUrl(url).pathname.replace(/\/{2,}/g, '/');
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** Same-origin redirect target for a request URL: canonical path plus the original query string. */
const safeRedirectTarget = (url) => canonicalPath(url) + parseRequestUrl(url).search;

/** Owner setup is done by the proxy itself. Express routes are case-insensitive, so compare lowercased. */
const isOwnerSetupPath = (path) => path.toLowerCase() === '/rest/owner/setup';

// Paths that must stay reachable without a browser session (external callers, health checks).
// Matched on whole path segments: `/webhook` covers `/webhook/x` but not `/webhookx`.
const PUBLIC_PATHS = ['/webhook', '/webhook-test', '/webhook-waiting', '/form', '/form-test', '/form-waiting',
  '/healthz', '/metrics', '/mcp', '/mcp-test', '/mcp-server', '/api/v1',
  '/rest/oauth1-credential/callback', '/rest/oauth2-credential/callback'];
const isPublicPath = (path) => {
  const p = path.toLowerCase();
  return PUBLIC_PATHS.some((pub) => p === pub || p.startsWith(`${pub}/`));
};

/** True when a browser page load has no n8n session and should be signed in automatically. */
function shouldAutoLogin(req) {
  const path = canonicalPath(req.url).toLowerCase();
  return req.method === 'GET'
    && !isPublicPath(path)
    && !path.startsWith('/rest/')
    && (req.headers.accept ?? '').includes('text/html')
    && !parseCookies(req.headers.cookie)['n8n-auth'];
}

/** Constant-time check of an `Authorization: Basic` header against the optional access password. */
function basicAuthOk(header, password) {
  if (!password) return true;
  const [scheme, value] = (header ?? '').split(' ');
  if (scheme !== 'Basic' || !value) return false;
  const given = Buffer.from(Buffer.from(value, 'base64').toString().split(':').slice(1).join(':'));
  const want = Buffer.from(password);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

module.exports = {
  n8nDatabaseEnv, pgOptions, newSecrets, parseCookies, canonicalPath, safeRedirectTarget,
  isOwnerSetupPath, isPublicPath, shouldAutoLogin, basicAuthOk,
};
