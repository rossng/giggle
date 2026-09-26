# giggle worker

One Cloudflare Worker serves the whole site:

- **Static files** (the SPA in `web/build`, gig data under `/data/`) come from Workers static
  assets, with `not_found_handling = "single-page-application"`. The Worker code doesn't run
  for them.
- **`/api/*`** (`run_worker_first`) is personal data, stored per user in D1 (`DB`). Today that's
  the board; unavailable dates, play history and settings come later.

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

Local D1 data lives in `worker/.wrangler/` (git-ignored); delete it to start over. `worker-dev`
serves whatever is in `web/build` (`make web-build`); for the app with hot reload, run `vite dev`
with `server.proxy = {'/api': 'http://127.0.0.1:8787'}` (keeps the `localhost` Host header).

Never run `wrangler deploy --env dev`.

## Setting up Cloudflare (once, by hand)

1. `wrangler d1 create giggle`; put the id in `wrangler.jsonc` (`d1_databases[0].database_id`),
   then `wrangler d1 migrations apply DB --remote`.
2. Zero Trust → Access → Applications → add a self-hosted app for `<hostname>/api/*` only, with a
   policy allowing your emails and the One-time PIN login method (free up to 50 users).
3. Copy the app's AUD tag and your team domain (`<team>.cloudflareaccess.com`) into `vars`
   (`ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`). Neither is a secret.
4. `make web-build`, then `wrangler deploy` from `worker/`, on the hostname Access protects.
