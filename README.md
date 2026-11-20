# n8n + Wasmer

One click gives you your own [n8n](https://n8n.io) workflow automation instance on **Wasmer Edge**. You sign in once, with your Wasmer account, and never create a separate n8n account.

[![Deploy to Wasmer](https://img.shields.io/badge/Deploy%20to-Wasmer-171717?logo=wasmer&logoColor=white)](https://wasmer.io/apps/create?github=ayushozha%2Fn8n-wasmer-starter)
![n8n 2.48.6](https://img.shields.io/badge/n8n-2.48.6-EA4B71)
![Node.js 24 on Edge.js](https://img.shields.io/badge/Node.js-24%20on%20Edge.js-339933?logo=nodedotjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/database-PostgreSQL-4169E1?logo=postgresql&logoColor=white)

`n8n` · `workflow automation` · `Edge.js (QuickJS)` · `managed PostgreSQL` · `one instance per deploy`

- [What you get](#what-you-get)
- [Status](#status)
- [How it works](#how-it-works)
- [Deploy](#deploy)
- [Configuration](#configuration)
- [Security model](#security-model)
- [Run locally](#run-locally)
- [Tests](#tests)
- [Repository map](#repository-map)
- [Limitations](#limitations)
- [License](#license)

## What you get

| Every time someone deploys this template | |
|---|---|
| A new Wasmer app | in **their** Wasmer account, at its own URL |
| A new PostgreSQL database | provisioned by Wasmer for that app only |
| A new n8n owner | created automatically on first boot, with a random password stored in that database |
| Its own encryption key | so credentials saved in one instance can't be decrypted by another |
| No n8n sign-up or login screen | opening the app URL drops you straight into the editor |

Two people who deploy the template get two completely separate instances. They share no data, passwords or sessions.

## Status

| Area | State |
|---|---|
| n8n 2.48.6 on Edge.js (QuickJS) with PostgreSQL | Verified locally with `wasmer run wasmer/edgejs-quickjs` (Wasmer 7.5.0) |
| Auto-created owner, auto-login, owner setup blocked, public webhooks | Verified locally, 7/7 end-to-end checks |
| Separate instances don't share data or sessions | Verified locally with two instances side by side |
| Restart keeps workflows and login | Verified locally |
| Hosted deploy on Wasmer Edge through the Deploy button | **Not yet verified** |
| Python Code node, multi-instance scaling, community nodes | Not supported (see [Limitations](#limitations)) |

## How it works

```
 browser ──https──▶ Wasmer Edge app (one per deploy)
                    │
                    ├─ server.js proxy  :$PORT
                    │    • first boot: creates the n8n owner
                    │    • page load without a session: signs in, sets the n8n-auth cookie
                    │    • /webhook, /form, /mcp, /api/v1 …: passed straight through (no login)
                    │    • /rest/owner/setup (any spelling): always blocked
                    │
                    ├─ n8n  127.0.0.1:5678  (same process, Edge.js QuickJS engine)
                    │
                    └─ Wasmer-managed PostgreSQL (DB_HOST, DB_PORT, DB_NAME, DB_USERNAME, DB_PASSWORD)
                         • n8n tables
                         • wasmer_n8n_kv: encryption key + owner login for this instance
```

1. The `Anybuild` file builds the repo as a Node.js server and declares a `postgres()` service, so Wasmer provisions a database for each app.
2. `server.js` maps Wasmer's `DB_*` variables onto n8n's `DB_POSTGRESDB_*` settings. TLS stays on, as Wasmer requires.
3. On first boot it creates a `wasmer_n8n_kv` table and stores a random encryption key and owner password there. Concurrent first boots agree through `INSERT … ON CONFLICT DO NOTHING`. Because the secrets live in the app's own database, they survive restarts, redeploys and database credential rotation without a volume.
4. It starts n8n on an internal port and a proxy on the public port. Once n8n is up, the proxy calls `POST /rest/owner/setup` and then signs page loads in with `POST /rest/login`.

Two compatibility settings make n8n run on Edge.js:

- `N8N_EXPRESSION_ENGINE=quickjs`. n8n's default expression engine needs `isolated-vm`, a V8-only native module. QuickJS runs expressions in a WebAssembly sandbox instead.
- `scripts/edgejs-compat.js` (post-install). n8n's `@n8n/expression-runtime` contains raw NUL bytes inside a template string, and Edge.js's QuickJS build stops reading source at the first NUL. The script rewrites each one as the equivalent `\x00` escape.

## Deploy

1. Click **Deploy to Wasmer** above and sign in to Wasmer.
2. Pick an app name. If the import page shows an **Enable Database** switch, turn it on and pick **PostgreSQL**.
3. Wait for the first boot. Database migrations take about a minute, and a "Starting n8n" page refreshes itself until it's done.
4. Open the app URL. You're in the n8n editor.

To reach the editor from another browser, just open the same URL; you're signed in automatically. If you set `WASMER_N8N_ACCESS_PASSWORD`, the browser asks for that password first.

## Configuration

All settings are optional. Set them as Wasmer app secrets or environment variables.

| Variable | Default | Effect |
|---|---|---|
| `WASMER_N8N_ACCESS_PASSWORD` | unset | When set, every page except the [public paths](#security-model) asks for HTTP Basic auth (any username, this password). Recommended if your app URL could leak. |
| `WASMER_N8N_AUTO_LOGIN` | `true` | Set to `false` to show n8n's normal sign-in page. The owner email is `owner@n8n.wasmer.app`; the password is in the `wasmer_n8n_kv` table (open it with **Databases → DB Explorer**). |
| `WEBHOOK_URL` | detected | The public URL n8n shows for webhooks. If it's unset, the first real visit records the app URL, and n8n uses it from the next restart on. Set it to `https://<app>.wasmer.app/` to have it right from the first boot. |
| `WASMER_N8N_DB_SSL` | `true` | TLS to the managed database. Only set it to `false` for a local Postgres without TLS. |
| `N8N_EXPRESSION_ENGINE` | `quickjs` | Leave as is on Wasmer. |
| Any other `N8N_*` / `DB_POSTGRESDB_*` | n8n defaults | Passed through to n8n unchanged. Explicit `DB_POSTGRESDB_*` values override the Wasmer database. |

Wasmer injects `PORT` and `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD` automatically.

## Security model

- **Anyone who has the app URL can use the instance.** The instance belongs to whoever deployed it, and the URL acts like a key. Set `WASMER_N8N_ACCESS_PASSWORD` if that isn't enough.
- These paths stay reachable without a session, so external services can call your workflows: `/webhook`, `/webhook-test`, `/webhook-waiting`, `/form`, `/form-test`, `/form-waiting`, `/mcp`, `/mcp-test`, `/mcp-server`, `/api/v1` (needs an n8n API key), `/rest/oauth1-credential/callback`, `/rest/oauth2-credential/callback`, `/healthz` and `/metrics`. They're matched on whole path segments.
- Nobody can claim the instance: the proxy answers `/rest/owner/setup` with 403, and the owner is created by the instance itself. Every check runs on the normalized path that n8n would route (`..` resolved, `//` collapsed, trailing `/` dropped, case-insensitive), and that normalized path is what gets forwarded.
- Auto-login redirects only ever point back to a path on the same instance.
- Each instance generates its own owner password and encryption key. They're stored only in that instance's database and never in the repo or in logs.

## Run locally

Locally this runs on regular Node.js 24. On Wasmer it runs on Edge.js.

```powershell
npm install
$env:DB_HOST="127.0.0.1"; $env:DB_PORT="5432"; $env:DB_NAME="n8n"; $env:DB_USERNAME="postgres"; $env:DB_PASSWORD="postgres"
$env:WASMER_N8N_DB_SSL="false"; $env:N8N_SECURE_COOKIE="false"
npm start   # then open http://localhost:8080
```

To run it under Edge.js the way Wasmer does (Linux or WSL, Wasmer 7.5+):

```bash
wasmer run --experimental-napi --net --volume "$PWD":/app wasmer/edgejs-quickjs \
  --env DB_HOST=127.0.0.1 --env DB_PORT=5432 --env DB_NAME=n8n --env DB_USERNAME=postgres --env DB_PASSWORD=postgres \
  --env WASMER_N8N_DB_SSL=false --env N8N_SECURE_COOKIE=false -- /app/server.js
```

## Tests

```bash
npm test
```

The unit tests cover database variable mapping, per-instance secrets, which requests get auto-login, which paths stay public, owner-setup path variants, same-site redirects, the optional access password, and the NUL-byte fix.

## Repository map

| Path | Role |
|---|---|
| `server.js` | Startup: database mapping, per-instance secrets, owner setup, auto-login proxy, starts n8n |
| `lib.js` | Pure helpers used by `server.js` (unit tested) |
| `lib.test.js` | Unit tests (`node --test`) |
| `scripts/edgejs-compat.js` | Post-install fix that escapes raw NUL bytes so Edge.js QuickJS can parse n8n |
| `Anybuild` | Wasmer build definition: Node.js server on Edge.js QuickJS, plus a PostgreSQL service |
| `package.json` | Pins `n8n` and `pg` |

## Limitations

- **One instance at a time.** n8n runs in regular (non-queue) mode, so schedules and triggers would fire once per running instance if Wasmer started several copies of the app.
- **Python Code node doesn't work.** It needs a Python task runner; the JavaScript Code node works.
- **Community nodes installed from the UI aren't kept** across restarts, because the n8n user folder isn't on a volume.
- **The first boot is slow**, about a minute while n8n creates its tables. Later boots take about 35–45 seconds locally.
- n8n is large (about 2.9 GB of `node_modules`), so the first build takes a while.

## License

There is no license file in this repo yet. n8n itself is distributed under the [Sustainable Use License](https://github.com/n8n-io/n8n/blob/master/LICENSE.md).
