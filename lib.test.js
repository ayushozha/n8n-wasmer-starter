'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('./lib');

const wasmerDb = { DB_HOST: 'psql.fr-roub1.example', DB_PORT: '15432', DB_NAME: 'db_abc', DB_USERNAME: 'u', DB_PASSWORD: 'p' };

test('maps Wasmer database variables to n8n Postgres settings with TLS', () => {
  assert.deepEqual(lib.n8nDatabaseEnv(wasmerDb), {
    DB_TYPE: 'postgresdb',
    DB_POSTGRESDB_HOST: 'psql.fr-roub1.example',
    DB_POSTGRESDB_PORT: '15432',
    DB_POSTGRESDB_DATABASE: 'db_abc',
    DB_POSTGRESDB_USER: 'u',
    DB_POSTGRESDB_PASSWORD: 'p',
    DB_POSTGRESDB_SSL_ENABLED: 'true',
    DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED: 'false',
  });
});

test('leaves explicit n8n database settings and missing databases alone', () => {
  assert.deepEqual(lib.n8nDatabaseEnv({ ...wasmerDb, DB_POSTGRESDB_HOST: 'mine' }), {});
  assert.deepEqual(lib.n8nDatabaseEnv({}), {});
  assert.equal(lib.n8nDatabaseEnv({ ...wasmerDb, WASMER_N8N_DB_SSL: 'false' }).DB_POSTGRESDB_SSL_ENABLED, undefined);
});

test('pg options mirror the n8n settings', () => {
  const opts = lib.pgOptions(lib.n8nDatabaseEnv(wasmerDb));
  assert.equal(opts.port, 15432);
  assert.deepEqual(opts.ssl, { rejectUnauthorized: false });
});

test('generated secrets are unique per instance and meet the n8n password policy', () => {
  const a = lib.newSecrets();
  const b = lib.newSecrets();
  assert.notEqual(a.owner_password, b.owner_password);
  assert.notEqual(a.encryption_key, b.encryption_key);
  for (const { owner_password: pw } of [a, b]) {
    assert.ok(pw.length >= 8 && pw.length <= 64);
    assert.match(pw, /\d/);
    assert.match(pw, /[A-Z]/);
  }
});

const page = (url, extra = {}) => ({ method: 'GET', url, headers: { accept: 'text/html,*/*', ...extra } });

test('auto-login only for browser page loads without a session', () => {
  assert.equal(lib.shouldAutoLogin(page('/')), true);
  assert.equal(lib.shouldAutoLogin(page('/workflow/new?x=1')), true);
  assert.equal(lib.shouldAutoLogin(page('/', { cookie: 'a=1; n8n-auth=tok' })), false);
  assert.equal(lib.shouldAutoLogin({ ...page('/'), method: 'POST' }), false);
  assert.equal(lib.shouldAutoLogin(page('/rest/settings')), false);
  assert.equal(lib.shouldAutoLogin({ method: 'GET', url: '/', headers: { accept: 'application/json' } }), false);
});

test('webhooks, forms and health checks never trigger login and stay public', () => {
  for (const p of ['/webhook/abc', '/webhook-test/abc', '/webhook-waiting/1', '/form/x', '/healthz', '/api/v1/workflows']) {
    assert.equal(lib.isPublicPath(p), true, p);
    assert.equal(lib.shouldAutoLogin(page(p)), false, p);
  }
  assert.equal(lib.isPublicPath('/home/workflows'), false);
});

test('owner setup cannot be reached through path variants', () => {
  for (const url of ['/rest/owner/setup', '/rest/owner/setup/', '//rest/owner/setup', '/rest//owner/setup',
    '/REST/Owner/Setup', '/x/../rest/owner/setup', '/webhook/../rest/owner/setup', '/rest/owner/%2e%2e/owner/setup',
    '/rest/owner/setup?x=1']) {
    assert.equal(lib.isOwnerSetupPath(lib.canonicalPath(url)), true, url);
  }
  assert.equal(lib.isOwnerSetupPath(lib.canonicalPath('/rest/owner/setupx')), false);
});

test('auto-login redirects never leave the instance', () => {
  for (const url of ['//evil.com', '//evil.com/path?q=1', '/\\evil.com', '/%2F%2Fevil.com', 'http://evil.com/x']) {
    const target = lib.safeRedirectTarget(url);
    assert.match(target, /^\/(?!\/)/, `${url} -> ${target}`);
    assert.equal(new URL(target, 'https://me.wasmer.app').host, 'me.wasmer.app', url);
  }
  assert.equal(lib.safeRedirectTarget('/workflow/new?x=1'), '/workflow/new?x=1');
});

test('public paths match whole segments only', () => {
  assert.equal(lib.isPublicPath('/webhookfoo'), false);
  assert.equal(lib.isPublicPath('/api/v2/x'), false);
  assert.equal(lib.isPublicPath('/apiary'), false);
  assert.equal(lib.isPublicPath('/mcp-server/http'), true);
  assert.equal(lib.isPublicPath(lib.canonicalPath('/webhook/../home')), false);
});

test('optional access password uses HTTP Basic auth', () => {
  const basic = (s) => `Basic ${Buffer.from(s).toString('base64')}`;
  assert.equal(lib.basicAuthOk(undefined, ''), true);
  assert.equal(lib.basicAuthOk(basic('any:s3cret:x'), 's3cret:x'), true);
  assert.equal(lib.basicAuthOk(basic('any:wrong'), 's3cret'), false);
  assert.equal(lib.basicAuthOk(undefined, 's3cret'), false);
  assert.equal(lib.basicAuthOk('Bearer abc', 's3cret'), false);
});

test('edgejs-compat escapes raw NUL bytes without changing what the code means', () => {
  const { escapeNul } = require('./scripts/edgejs-compat');
  const src = Buffer.from('const k = `${a}\u0000${b}`; const r = /\u0000/;');
  const out = escapeNul(src).toString();
  assert.equal(out.includes('\u0000'), false);
  const a = 'x';
  const b = 'y';
  // eslint-disable-next-line no-eval
  assert.equal(eval(`\`\${a}${out.slice(out.indexOf('}') + 1, out.lastIndexOf('$'))}\${b}\``), 'x\u0000y');
});

test('cookie parsing', () => {
  assert.deepEqual(lib.parseCookies('a=1; b=x%20y; flag'), { a: '1', b: 'x y', flag: '' });
  assert.deepEqual(lib.parseCookies(undefined), {});
});
