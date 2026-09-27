# giggle worker

One Cloudflare Worker serves the whole site:

- **Static files** (the SPA in `web/build`, gig data under `/data/`) come from Workers static
  assets, with `not_found_handling = "single-page-application"`. The Worker code doesn't run
  for them.
- **`/api/*`** (`run_worker_first`) is personal data, stored per user in D1 (`DB`): the board,
  unavailable dates and the radio's play history. Settings may come later.
- **`/models/*`** (`run_worker_first`) is the browser's Kokoro model, from R2 (`MODELS`): public,
  no auth. See [Model files](#model-files).

## API

All JSON, all `Cache-Control: no-store`. Errors are `{"error": "..."}`.

| Request | Response |
| --- | --- |
| `GET /api/me` | `{user, via: "passkey" \| "dev", passkeys}`, or 401 when signed out |
| `POST /api/passkey/register/options` `{}` | `{ticket, options}`: WebAuthn creation options (signed in: for another device on this account) |
| `POST /api/passkey/register/verify` `{ticket, response}` | `{user, via}` + session cookie; a new account unless signed in |
| `POST /api/passkey/login/options` `{}` | `{ticket, options}`: WebAuthn request options (any giggle passkey) |
| `POST /api/passkey/login/verify` `{ticket, response}` | `{user, via}` + session cookie |
| `POST /api/logout` `{}` | ends this browser's session |
| `GET /api/<collection>?since=<cursor>` | `{items, cursor, more}`: rows changed after `cursor` (omit for all), tombstones included, at most 1000 per page; ask again with `cursor` while `more` |
| `PUT /api/<collection>` `{items: [...]}` | `{items}`: the stored rows for those keys after last-write-wins |

`<collection>` is one of three, all synced the same way (`src/collections.ts`, `src/store.ts`):

| Collection | Item | Deletion | Limit |
| --- | --- | --- | --- |
| `board` | `{key, state, name, gig?, at}`: `key` is `mb:<mbid>` or `name:<normalised name>`, `state` `listen`/`go`/`tickets`/`nope` | `state: null` | 20 000 rows (413) |
| `unavailable` | `{key, label?, at}`: `key` is a day `2026-10-03`, a range `2026-10-10/2026-10-17` (both ends included, in order, at most 366 days, one day written as the day) or a weekday `weekly:mon` … `weekly:sun`; dates are Amsterdam dates; `label` ≤ 100 characters | `{key, deleted: true, at}` | 2 000 rows (413) |
| `plays` | `{key: artist key, at: when it was heard}`; a play is its artist and time together, so the same play sent twice is stored once | none | 60 days, 10 000 rows |

Per key the later `at` wins; on a tie the stored row stays. `at` more than 10 minutes ahead of the
server is clamped to the server's clock. Plays are never changed, only added: two devices' histories
merge into the union. Plays more than 10 minutes in the future or older than 60 days are dropped
(left out of the response, the batch still succeeds), and when writing, plays older than 60 days
and the oldest past 10 000 are forgotten (never the row with the highest `seq`, so cursors stay
valid; there may be one extra).

The `since` cursor is a per-user, per-collection change counter, not a time: every accepted write
gets a higher one, so no change is missed because of clock differences between devices or
Cloudflare locations.

Validation is strict and whole-batch: `Content-Type: application/json` (else 415), body ≤ 256 KB
and ≤ 500 items (else 413/400), no unknown fields, no duplicate keys, names ≤ 300 characters, no
control characters. See `src/validate.ts` and `src/collections.ts`.

Storage: one table, `sync_items (user, collection, key, data, at, seq)`, `data` being the item's
JSON or NULL for a tombstone (`migrations/0002_sync_items.sql`, which moved the board's rows over
from 0001's `board_items` with their keys, times and seqs, so existing cursors stay valid).

The web client is `web/src/lib/sync/` (`SyncClient` over `collection.ts`/`collections.ts`).

## Who is asking

People sign in with **passkeys** (`src/passkeys.ts`, `@simplewebauthn/server`): no password, no
email. An account is an id (`u_<uuid>`, table `accounts`) with one or more passkeys (`passkeys`:
credential id, COSE public key, counter, transports). A passkey synced by the listener's password
manager (iCloud Keychain, Google, 1Password…) signs them in on their other devices; a device
without it signs in through the browser's "use a phone" QR flow, then can add its own passkey
(registering while signed in adds to that account, at most 20). Each ceremony's challenge lives
five minutes under a random ticket and is used once (`challenges`). Signing in sets
`giggle_session` (random 256-bit token, only its SHA-256 stored in `sessions`; `Path=/api`,
`HttpOnly`, `SameSite=Lax`, `Secure` on https, 400 days). Synced data is stored under the account
id. The web side is `/account` (`web/src/lib/account/passkeys.ts`).

Exactly two configurations are accepted (`src/config.ts`); anything else answers 500 on `/api/*`:

- **Production** (top level of `wrangler.jsonc`): `ENVIRONMENT=production`, `PASSKEY_RP_ID` = the
  site's hostname (passkeys are bound to it: moving the site to another hostname means registering
  passkeys again) and `SITE_ORIGINS` = its https origin(s). Only sessions count; the dev header and
  cookie are never read.
- **Dev** (`env.dev`, only used by `wrangler dev --env dev`): `ENVIRONMENT=dev`,
  `PASSKEY_RP_ID=localhost` (anything else is refused) and the local origins. Passkeys work on
  localhost too; so does a fake user from the `X-Giggle-Dev-User: alice@example.test` header or the
  `giggle_dev_user` cookie (set it in a browser with `/api/dev/login?as=alice@example.test`, clear
  with `/api/dev/logout`), only when the request's hostname is `localhost`, `127.0.0.1`, `[::1]` or
  `*.localhost`. Tests sign in with a software authenticator (`test/authenticator.ts`); browser
  tests can use Chromium's virtual one (CDP `WebAuthn.addVirtualAuthenticator`).

## Model files

The radio's live announcer runs Kokoro-82M in the browser (`web/src/lib/voice/`). Its files come
from our origin, never from Hugging Face at runtime:
`GET|HEAD /models/<name>/<revision>/<file>` (`src/models.ts`), e.g.
`/models/kokoro-82m-v1.0/1939ad2a…/onnx/model_quantized.onnx`.

- **What**: exactly the files in `web/src/lib/voice/model-files.json`, a mirror of
  [`onnx-community/Kokoro-82M-v1.0-ONNX`](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)
  pinned to one commit, with each file's size and SHA-256: `config.json`, the tokenizer files,
  fp32 (`onnx/model.onnx`, 326 MB, used on WebGPU), q8 (`onnx/model_quantized.onnx`, 92 MB, used
  on WASM) and the two announcer voices. Anything else in the bucket is never served (404).
- **Headers**: `Cache-Control: public, max-age=31536000, immutable` (the revision is in the path),
  `ETag` = the SHA-256 (`If-None-Match` → 304), `Content-Type` by extension, single `Range`
  requests (206/416; transformers.js doesn't use them, but resumed downloads can). 404s are
  `no-store`.
- **Storage**: R2 key = the path after `/models/`. Files over the manifest's `partSize` (256 MiB)
  are stored as `<key>.part0`, `<key>.part1`, …, because `wrangler r2 object put` uploads at most
  300 MiB; the Worker checks every part's size against the manifest and streams them as one file.
  Today that's only `onnx/model.onnx` (2 parts).
- **Browser side**: `kokoro.worker.ts` sets transformers.js's `env.remoteHost` /
  `remotePathTemplate` to this path and wraps the worker's `fetch` (`model-source.ts`) to send
  kokoro-js's hardcoded Hugging Face voice URL here too, and to refuse any other request to
  Hugging Face. If the files are missing in production, Kokoro fails to load and the radio uses
  Web Speech. Under `vite dev` only, a file this route can't serve comes from Hugging Face at the
  pinned commit (with a console warning), so the web app works without `make models`.

`scripts/models.mjs fetch` downloads the pinned files into `data/cache/web-models/` (ignored by
git; not the pipeline's `data/cache/models/`, which is kokoro-onnx's different format) and checks
size and SHA-256, skipping files that already match. `put --local` / `put --remote` fetches,
re-checks, splits and runs `wrangler r2 object put` for each object.

To change the model (another revision, or a precision such as fp16): edit `model-files.json` (the
commit; each file's size and SHA-256, which
`https://huggingface.co/api/models/<repo>/paths-info/<commit>` lists as `lfs.oid` for large files),
run `make models`, test, then upload and deploy as below. Old files can stay in the bucket; the
web app deletes superseded ones from the browser's cache.

## Running it locally

```sh
make worker-dev        # applies migrations to the local D1, then wrangler dev on 127.0.0.1:8787
make worker-test       # vitest inside workerd with a local D1 (pnpm --dir worker test)
pnpm --dir worker typecheck
```

```sh
curl -H 'X-Giggle-Dev-User: alice@example.test' http://127.0.0.1:8787/api/me
curl -X PUT -H 'X-Giggle-Dev-User: alice@example.test' -H 'Content-Type: application/json' \
  -d '{"items":[{"key":"name:mogwai","state":"go","name":"Mogwai","at":"2026-09-26T19:00:00Z"}]}' \
  http://127.0.0.1:8787/api/board
curl -H 'X-Giggle-Dev-User: bob@example.test' http://127.0.0.1:8787/api/board   # bob sees nothing
curl -X PUT -H 'X-Giggle-Dev-User: alice@example.test' -H 'Content-Type: application/json' \
  -d '{"items":[{"key":"weekly:mon","at":"2026-09-26T19:00:00Z"},{"key":"2026-10-10/2026-10-17","label":"Lisbon","at":"2026-09-26T19:00:00Z"}]}' \
  http://127.0.0.1:8787/api/unavailable
curl -H 'X-Giggle-Dev-User: alice@example.test' http://127.0.0.1:8787/api/plays
```

```sh
make models            # once, ~420 MB: the browser's Kokoro files into the local R2
curl -I http://127.0.0.1:8787/models/kokoro-82m-v1.0/1939ad2a8e416c0acfeecc08a694d14ef25f2231/onnx/model.onnx
```

If `:8787` is taken (say by `make dev` in another checkout), pass wrangler another port:
`pnpm --dir worker exec wrangler dev --env dev --ip 127.0.0.1 --port 8797 --inspector-port 9239`.

Local D1 and R2 data live in `worker/.wrangler/` (git-ignored); delete it to start over (then
`make models` again). `worker-dev` serves whatever is in `web/build` (`make web-build`); for the
app with hot reload, `make web-dev` runs `vite dev`, which proxies `/api` and `/models` to
`http://127.0.0.1:8787` (keeping the `localhost` Host header; `GIGGLE_WORKER=<url>` changes it).

Never run `wrangler deploy --env dev`.

## Deploying

`.github/workflows/deploy.yml` deploys: after every successful nightly (new data) and every green
test run on `main` (new code), or by hand (`gh workflow run deploy.yml`). It takes a commit whose
tests passed (a nightly deploys `main` as it is), the latest nightly `site-data` artifact, runs
`make web-build` (which copies only the announcer clips `artists.json` uses), applies D1
migrations (`--remote`), `wrangler deploy`s the top-level (production) config, then
`scripts/smoke-test.mjs` checks the live site: pages, data, a clip, the model files, that
`/api/me` is 401 signed out, and that passkeys are offered for the site's hostname. It skips (with a notice) until the D1 id and the deploy
token below exist. The site's URL is what wrangler prints (`giggle.<subdomain>.workers.dev`), or
the repo variable `SITE_URL` for a custom domain. Nothing here deploys from a laptop.

## Setting up Cloudflare (once, by hand)

wrangler is this package's dev dependency, not a global command: run it from `worker/` inside the
toolchain shell (`direnv allow` or `nix develop`) as `pnpm exec wrangler …`, and sign in once with
`pnpm exec wrangler login`.

1. The database: `pnpm exec wrangler d1 create giggle`, and put the id it prints in
   `wrangler.jsonc` (the top-level `d1_databases[0].database_id`; it isn't a secret). The deploy
   workflow applies the migrations.
2. The model bucket: `pnpm exec wrangler r2 bucket create giggle-models`, then
   `node scripts/models.mjs put --remote`. That downloads the files into `data/cache/web-models/`
   if needed, checks every SHA-256 and uploads 8 objects (~420 MB) with
   `wrangler r2 object put --remote`, as your `wrangler login`. Run it again whenever
   `model-files.json` changes, before deploying. Keep the bucket private (no r2.dev URL or custom
   domain: the Worker serves it).
3. A deploy token for GitHub Actions: My Profile → API Tokens → Create Token → "Edit Cloudflare
   Workers" template, plus Account → D1 → Edit; then `gh secret set CLOUDFLARE_DEPLOY_TOKEN`.
   (`CLOUDFLARE_ACCOUNT_ID` is already a secret; `CLOUDFLARE_API_TOKEN` is the pipeline's Workers
   AI token and stays as it is.)
4. The first deploy: `gh workflow run deploy.yml`. The run's log ends with the site's URL; put
   its hostname in `PASSKEY_RP_ID` and its origin in `SITE_ORIGINS` (top-level `vars`) if they
   differ from what's there. Sign-in needs nothing else: no Zero Trust, no email service.
5. Check any time: `node scripts/smoke-test.mjs https://giggle.<subdomain>.workers.dev`.
