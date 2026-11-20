'use strict';
// n8n on Wasmer Edge, one instance per deploy, no separate n8n sign-up.
//
// 1. Maps the app's own managed Postgres (DB_* from Wasmer) onto n8n's settings.
// 2. Keeps this instance's secrets (encryption key, owner login) in that same database,
//    so they survive restarts, redeploys and credential rotation without a volume.
// 3. Starts n8n on an internal port and a small proxy on the public port. On first boot
//    the proxy creates the n8n owner; afterwards it signs browser visits in automatically.

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('pg');
const lib = require('./lib');

const env = process.env;
const PUBLIC_PORT = Number(env.PORT ?? 8080);
const N8N_PORT = Number(env.N8N_PORT ?? 5678);
const ACCESS_PASSWORD = env.WASMER_N8N_ACCESS_PASSWORD ?? '';
const AUTO_LOGIN = env.WASMER_N8N_AUTO_LOGIN !== 'false';
const log = (...a) => console.log('[wasmer-n8n]', ...a);

async function loadSecrets() {
  const db = new Client(lib.pgOptions(env));
  await db.connect();
  try {
    await db.query('CREATE TABLE IF NOT EXISTS wasmer_n8n_kv (key text PRIMARY KEY, value text NOT NULL)');
    // ON CONFLICT keeps the first value, so concurrent first boots agree on one set of secrets.
    for (const [key, value] of Object.entries(lib.newSecrets())) {
      await db.query('INSERT INTO wasmer_n8n_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, value]);
    }
    const { rows } = await db.query('SELECT key, value FROM wasmer_n8n_kv');
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } finally {
    await db.end();
  }
}

async function rememberPublicUrl(url) {
  const db = new Client(lib.pgOptions(env));
  await db.connect();
  try {
    await db.query("INSERT INTO wasmer_n8n_kv (key, value) VALUES ('public_url', $1) ON CONFLICT (key) DO NOTHING", [url]);
  } finally {
    await db.end();
  }
}

/** Call n8n's own REST API on the internal port. */
function n8nRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body && JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: N8N_PORT, method, path: urlPath,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

let ready = false;

async function waitForN8nAndSetupOwner(secrets) {
  for (;;) {
    const res = await n8nRequest('GET', '/rest/settings').catch(() => null);
    // While starting, n8n answers 200 with a plain-text "starting up" page, so require real JSON.
    let settings;
    try { settings = res?.status === 200 && JSON.parse(res.text).data; } catch { settings = undefined; }
    if (settings) {
      if (settings.userManagement?.showSetupOnFirstLoad) {
        const setup = await n8nRequest('POST', '/rest/owner/setup', {
          email: secrets.owner_email, firstName: 'Wasmer', lastName: 'Owner', password: secrets.owner_password,
        });
        // A 400 here means another instance created the owner first with the same stored secrets.
        log(setup.status === 200 ? 'created the n8n owner for this instance' : `owner setup returned ${setup.status}`);
      }
      ready = true;
      log(`n8n is ready behind port ${PUBLIC_PORT}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function login(secrets) {
  const res = await n8nRequest('POST', '/rest/login', {
    emailOrLdapLoginId: secrets.owner_email, password: secrets.owner_password,
  });
  if (res.status !== 200) throw new Error(`n8n login failed with ${res.status}: ${res.text.slice(0, 200)}`);
  return [res.headers['set-cookie'] ?? []].flat();
}

const STARTING_PAGE = '<!doctype html><meta http-equiv="refresh" content="3"><title>Starting n8n</title>'
  + '<body style="font-family:system-ui;padding:3rem">n8n is starting. The first boot sets up the database '
  + 'and can take a minute; this page refreshes by itself.</body>';

function forwardedHeaders(req) {
  return {
    ...req.headers,
    'x-forwarded-for': req.headers['x-forwarded-for'] ?? req.socket.remoteAddress,
    'x-forwarded-proto': req.headers['x-forwarded-proto'] ?? 'https',
    'x-forwarded-host': req.headers['x-forwarded-host'] ?? req.headers.host,
  };
}

function startProxy(secrets) {
  let urlRecorded = Boolean(env.WEBHOOK_URL);
  const server = http.createServer(async (req, res) => {
    // Decide on, and forward, the canonical path so n8n routes exactly what was checked here.
    const urlPath = lib.canonicalPath(req.url);
    const target = lib.safeRedirectTarget(req.url);
    if (!lib.isPublicPath(urlPath) && !lib.basicAuthOk(req.headers.authorization, ACCESS_PASSWORD)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="n8n"' }).end('Authentication required');
      return;
    }
    // Owner setup is done once by this proxy; never let a visitor claim the instance.
    if (lib.isOwnerSetupPath(urlPath)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('The owner is created automatically.');
      return;
    }
    if (!ready) {
      res.writeHead(503, { 'content-type': 'text/html', 'retry-after': '3' }).end(STARTING_PAGE);
      return;
    }
    if (!urlRecorded && req.headers.host && !req.headers.host.startsWith('127.0.0.1')) {
      urlRecorded = true;
      const proto = req.headers['x-forwarded-proto'] ?? 'https';
      rememberPublicUrl(`${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host}/`)
        .catch((e) => log('could not store public URL:', e.message));
    }
    if (AUTO_LOGIN && lib.shouldAutoLogin(req)) {
      try {
        const cookies = await login(secrets);
        const location = ['/signin', '/signout', '/setup'].includes(urlPath.toLowerCase()) ? '/' : target;
        res.writeHead(302, { location, 'set-cookie': cookies, 'cache-control': 'no-store' }).end();
        return;
      } catch (e) {
        log(e.message); // fall through to n8n's own sign-in page
      }
    }
    const upstream = http.request({
      host: '127.0.0.1', port: N8N_PORT, method: req.method, path: target, headers: forwardedHeaders(req),
    }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('n8n is not reachable yet');
    });
    // A client that disconnects mid-upload must not crash the process.
    req.on('error', () => upstream.destroy());
    res.on('error', () => upstream.destroy());
    req.pipe(upstream);
  });

  // WebSocket upgrades (n8n's live editor updates) are piped straight through.
  // Node's HTTP parser has already rejected CR/LF in the URL and headers, so writing them back is safe.
  server.on('upgrade', (req, socket, head) => {
    const urlPath = lib.canonicalPath(req.url);
    if (lib.isOwnerSetupPath(urlPath)
      || (!lib.isPublicPath(urlPath) && !lib.basicAuthOk(req.headers.authorization, ACCESS_PASSWORD))) {
      return socket.destroy();
    }
    const up = net.connect(N8N_PORT, '127.0.0.1', () => {
      const headers = forwardedHeaders(req);
      up.write(`${req.method} ${lib.safeRedirectTarget(req.url)} HTTP/1.1\r\n`
        + Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      up.write(head);
      up.pipe(socket).pipe(up);
    });
    const close = () => { up.destroy(); socket.destroy(); };
    up.on('error', close);
    socket.on('error', close);
  });

  server.listen(PUBLIC_PORT, '0.0.0.0', () => log(`proxy listening on ${PUBLIC_PORT}`));
}

function startN8n() {
  // Run n8n's own launcher in this process, as `n8n start` would.
  const bin = require.resolve('n8n/bin/n8n');
  process.argv = [process.argv[0], bin, 'start'];
  require(bin);
}

async function main() {
  Object.assign(env, lib.n8nDatabaseEnv(env));
  if (env.DB_TYPE !== 'postgresdb') {
    console.error('[wasmer-n8n] No Postgres configured. Deploy with the app.yaml in this repo so Wasmer '
      + 'provisions a database, or set DB_POSTGRESDB_* yourself.');
    process.exit(1);
  }

  const secrets = await loadSecrets();
  env.N8N_ENCRYPTION_KEY ??= secrets.encryption_key;
  env.WEBHOOK_URL ??= secrets.public_url;
  env.N8N_PORT = String(N8N_PORT);
  env.N8N_LISTEN_ADDRESS ??= '127.0.0.1';
  env.N8N_PROXY_HOPS ??= '1';
  // n8n turns off Happy Eyeballs, so prefer IPv4 where IPv6 egress is unavailable.
  env.NODEJS_PREFER_IPV4 ??= 'true';
  // isolated-vm is a V8-only native module; QuickJS runs expressions in a WebAssembly sandbox instead.
  env.N8N_EXPRESSION_ENGINE ??= 'quickjs';
  env.N8N_USER_FOLDER ??= path.join(os.tmpdir(), 'n8n');
  fs.mkdirSync(env.N8N_USER_FOLDER, { recursive: true });

  startProxy(secrets);
  startN8n();
  await waitForN8nAndSetupOwner(secrets);
}

main().catch((e) => {
  console.error('[wasmer-n8n] startup failed:', e);
  process.exit(1);
});
