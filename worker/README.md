# giggle worker

One Cloudflare Worker serves the whole site:

- **Static files** (the SPA in `web/build`, gig data under `/data/`) come from Workers static
  assets, with `not_found_handling = "single-page-application"`. The Worker code doesn't run
  for them.
- **`/api/*`** (`run_worker_first`) is personal data, stored per user in D1 (`DB`). Today that's
  the board; unavailable dates, play history and settings come later.
- **`/models/*`** (`run_worker_first`) is the browser's Kokoro model, from R2 (`MODELS`): public,
  no auth. See [Model files](#model-files).

## API

All JSON, all `Cache-Control: no-store`. Errors are `{"error": "..."}`.

| Request | Response |
| --- | --- |
| `GET /api/me` | `{email, via: "access" \| "dev"}` |
| `GET /api/board?since=<cursor>` | `{items, cursor, more}`: rows changed after `cursor` (omit for all), tombstones included, at most 1000 per page; ask again with `cursor` while `more` |
| `PUT /api/board` `{items: [...]}` | `{items}`: the stored rows for those keys after last-write-wins |

An item is `{key, state, name, gig?, at}`: `key` is `mb:<mbid>` or `name:<normalised name>`,
`state` is `listen`/`go`/`tickets`/`nope`, or `null` for a deletion (tombstone), `at` is when the
client made the change (ISO 8601). Per key the later `at` wins; on a tie the stored row stays.
`at` more than 10 minutes ahead of the server is clamped to the server's clock.

The `since` cursor is a per-user change counter, not a time: every accepted write gets a higher
one, so no change is missed because of clock differences between devices or Cloudflare locations.

Validation is strict and whole-batch: `Content-Type: application/json` (else 415), body ≤ 256 KB
and ≤ 500 items (else 413/400), no unknown fields, no duplicate keys, names ≤ 300 characters, no
control characters; at most 20 000 rows per user (413). See `src/validate.ts`.

The web client is `web/src/lib/sync/` (`SyncClient`, `mergeBoards`, `diffBoards`).

## Who is asking

Exactly two configurations are accepted (`src/config.ts`); anything else answers 500 on `/api/*`:

- **Production** (top level of `wrangler.jsonc`): `ENVIRONMENT=production` plus
  `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Cloudflare Access protects `/api/*`; the Worker verifies
  the `Cf-Access-Jwt-Assertion` JWT (RS256, `aud` = the Access app's AUD tag, `iss` =
  `https://<team>.cloudflareaccess.com`, keys from `/cdn-cgi/access/certs`) and uses its `email`.
  The dev header and cookie are never read.
- **Dev** (`env.dev`, only used by `wrangler dev --env dev`): `ENVIRONMENT=dev` and **no** Access
  vars (dev plus Access vars is refused). The user is the `X-Giggle-Dev-User: alice@example.test`
  header or the `giggle_dev_user` cookie (set it in a browser with
  `/api/dev/login?as=alice@example.test`, clear with `/api/dev/logout`), and only when the request's
  hostname is `localhost`, `127.0.0.1`, `[::1]` or `*.localhost`.

The SPA sends `X-Requested-With: XMLHttpRequest`, so an expired Access session gets a 401 instead of
a redirect, and the client shows "signed out".

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
```

```sh
make models            # once, ~420 MB: the browser's Kokoro files into the local R2
curl -I http://127.0.0.1:8787/models/kokoro-82m-v1.0/1939ad2a8e416c0acfeecc08a694d14ef25f2231/onnx/model.onnx
```

Local D1 and R2 data live in `worker/.wrangler/` (git-ignored); delete it to start over (then
`make models` again). `worker-dev` serves whatever is in `web/build` (`make web-build`); for the
app with hot reload, `make web-dev` runs `vite dev`, which proxies `/api` and `/models` to
`http://127.0.0.1:8787` (keeping the `localhost` Host header; `GIGGLE_WORKER=<url>` changes it).

Never run `wrangler deploy --env dev`.

## Setting up Cloudflare (once, by hand)

1. `wrangler d1 create giggle`; put the id in `wrangler.jsonc` (`d1_databases[0].database_id`),
   then `wrangler d1 migrations apply DB --remote`.
2. Zero Trust → Access → Applications → add a self-hosted app for `<hostname>/api/*` only, with a
   policy allowing your emails and the One-time PIN login method (free up to 50 users).
3. Copy the app's AUD tag and your team domain (`<team>.cloudflareaccess.com`) into `vars`
   (`ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`). Neither is a secret.
4. The model bucket, from `worker/`: `wrangler r2 bucket create giggle-models` (before the first
   deploy: `wrangler.jsonc` binds it), then `node scripts/models.mjs put --remote`. That
   downloads the files into `data/cache/web-models/` if needed, checks every SHA-256 and uploads
   8 objects (~420 MB) with `wrangler r2 object put --remote`, as your `wrangler login`. Run it
   again whenever `model-files.json` changes, before deploying. Keep the bucket private (no
   r2.dev URL or custom domain: the Worker serves it) and `/models/*` outside Access.
5. `make web-build`, then `wrangler deploy` from `worker/`, on the hostname Access protects.
   Check: `curl -sI https://<hostname>/models/kokoro-82m-v1.0/<revision>/config.json` is 200
   with `Cache-Control: public, max-age=31536000, immutable`.
