# giggle

Upcoming gigs in and around Amsterdam, and a radio that plays the artists. Design report:
https://claude.ai/artifact/6PDPXr3LtbEbPPLUxQPXWR. Architecture diagram: README.md.

## Layout
- `packages/podia/` — venue agenda library, published separately (Blue Oak 1.0.0). Must stay
  app-agnostic: no artist matching, LLM calls, genre filtering or giggle-specific logic. Its HTTP
  client is polite (robots.txt, crawl delay; a Crawl-delay over 30 s counts as a refusal), talks
  to public hosts only, follows http(s) redirects only, caps decoded bodies (20 MB; gzip/deflate,
  one layer) and time (180 s a request, optional client deadline). Adapters build fetched URLs
  with `site_url`, which keeps them on the venue's host.
- `pipeline/` — nightly build (`giggle-build`): collect venues in parallel (10 minutes each), fetch
  detail pages for new/soon events (`details.py`), drop out-of-scope events by `scope.toml` (each
  with a reason), merge cross-venue duplicates, LLM line-ups (`lineup.py`), artists (`enrich.py`:
  MusicBrainz, Last.fm, Wikipedia, YouTube Music songs within 60 days), announcer blurbs
  (`blurbs.py`) and Kokoro clips (`clips.py`) for playable artists. Per-run budgets everywhere;
  everything cached in `data/cache/` (with expiry for "not found" answers). URL fields in the site
  JSON are http(s) only (`urls.py`); each playable artist gets an `announcer` voice. Untrusted
  text in logs stays on one line (`text.one_line`: `::` lines are workflow commands).
  - Health: `health.json` lists venue problems and `pipeline` problems (llm / ytmusic / voice /
    musicbrainz), printed as `::warning::` lines. `giggle-issues` opens one GitHub issue per venue
    after 2 bad nights in a row (streaks from `health-history.json`, which also tracks in-scope
    counts) and per pipeline problem at once; it comments only when the cause changes, or weekly.
    Error text goes in unbreakable code blocks (`quoted`); only the bot's own cause markers count.
  - LLM: one Workers AI budget per run (`--llm-max-calls 200`; line-ups ≤ `--llm-lineup-max-calls
    120`, blurbs get the rest; the account's free allowance is ~200 calls a day, shared with any
    local `make data`). A spent daily quota stops the night's LLM work. When a task changes model,
    put the old one in `llm.PREVIOUS_MODELS` so cached answers still count.
- `web/` — SvelteKit 2 + Svelte 5 static SPA (adapter-static, `ssr = false`). `/` lands on the
  Agenda; the nav is Agenda · Radio · Board.
  - One shell for every page (`routes/(app)/+layout.svelte`, `lib/components/shell/`): TopBar
    (sections, About, account; tabs at the bottom on phones), a global PlayerBar (announcements on
    the scrub bar), the Station & settings drawer, and VideoDock, the app's only YouTube iframe
    (never moved in the DOM: over the Radio page's slot, else a floating tile ≥200px; tucking it
    pauses; while the announcer talks a track in, that track's thumbnail covers the last one's). The
    radio is app-wide (`lib/radio/app.svelte.ts`: one Radio in its own `$effect.root`; the station
    is app state that /radio's URL mirrors), so pages never stop playback.
    `lib/radio/media-focus.ts` keeps the laptop's media keys on giggle, not YouTube. Every page's
    code preloads when idle (`lib/pages.ts`; a new route needs a path there, its test checks), so a
    deploy mid-visit never forces a reload that would stop the radio.
  - Radio (`lib/radio/`): controller in `radio.svelte.ts`, YouTube Player, ClipSpeaker playing the
    pipeline's intro clips (`/data/voice/*.mp3`), then KokoroSpeaker saying live lines with Kokoro
    in the browser (`lib/voice/`, see Voices) and Web Speech as its fallback; per-station session
    persistence, Media Session. Whatever changes the queue goes through `#follow` (plays when on,
    else cues), so the embed, clock and caption never show a track the radio left. Songs YouTube
    won't embed (errors 100/101/150) are remembered per browser for 14 days and left out; they
    can't be checked ahead (ytmusicapi, oEmbed and the embed page all say they're fine).
  - Personal data, one reactive store each: the board (`lib/board/board-store.svelte.ts`,
    `boardStore`: the radio and every page read and write it. An artist's state, listen more or
    not for me, is keyed by artist and only steers the radio; a gig's, want to go or got
    tickets, is keyed `gig:<gig id>`, with the artist it was for. On the radio, a plan for an
    artist with several gigs on the station asks which (`GigChoice`). `parseBoard` converts the
    older artist-only format and the sync pushes the result; the Worker still accepts the old
    format, from tabs not reloaded yet. That code is marked `LEGACY-BOARD`: a month after the
    split deploys, the Worker can refuse old-format writes (plans on an artist key, `gig`); the
    conversion goes only with a D1 migration converting rows still in the old format, and
    devices last used signed out before the split would then lose their old plans), unavailable
    dates
    (`lib/data/unavailable-store.svelte.ts`) and play history; synced by `lib/sync/` (`SyncClient`
    over generic `collections.ts`). Signing out clears the device's copy (`forget()`); signing in
    shows the account's data; only a brand-new account adopts data made signed out
    (`prepareSignIn`); another account's data is dropped.
  - `/admin` (not in the nav; `lib/admin/`): the owner's usage panel, hand-drawn SVG charts,
    flags for possible abuse. `make seed-dev` fills the local D1 for it (as alice).
  - One filter model (`lib/data/filters.ts`) lives in the URL; genre buckets expand to specific
    styles (`lib/data/styles.ts`, `style=`); `hide=unavailable` uses the listener's own dates,
    `board=listen` their listen-more artists (`Personal`, `lib/data/personal.ts`; the radio then
    plays just those artists, not the rest of their gigs' line-ups).
  - UI: primary controls up front, the rest behind drawers or "More" disclosures. Shared pieces:
    `Sheet.svelte` (every dialog/drawer), `TriageButtons.svelte`, and app.css's `.seg`,
    `.ellipsis`, `.tap` and triage colour tokens (`--listen`, `--go`, `--tickets`, `--nope`).
    Touch (`pointer: coarse`): no key hints (`kbd`, `.kbd-hint` are hidden), ≥44px targets.
- `packages/radio-core/` — TypeScript radio engine (queue, Mix/Shuffle, session restore,
  presenter and announcer text, timing, ducking): framework-free, deterministic, no runtime deps.
  Its types declare only the fields it reads, so web's full types (`web/src/lib/data/types.ts`)
  fit without casts. Web imports it as `@giggle/radio-core` via the root pnpm workspace.
- `worker/` — Cloudflare Worker (wrangler 4, `wrangler.jsonc`): serves `web/build` as static
  assets, `/models/*` (the browser's Kokoro files from R2, only those in
  `web/src/lib/voice/model-files.json`) and the per-user `/api` on D1: `/api/<collection>` for the
  board, unavailable dates and play history (one generic mechanism: `src/collections.ts`,
  `src/store.ts`, table `sync_items`; LWW per key, tombstones, `since` cursor; plays merge as a
  union). Sign-in is passkeys (`src/passkeys.ts`, @simplewebauthn; an account is an id with
  passkeys; a `__Host-giggle_session` cookie; list/add/remove passkeys, sign out everywhere,
  delete the account; adding or removing a passkey and deleting the account need a passkey
  confirmation in the last five minutes, `reauth`), bound to `PASSKEY_RP_ID` (the site
  hostname), plus a dev identity only with `--env dev` on localhost. Rate limits
  (`src/limits.ts`, `ratelimits` bindings): all of `/api`, sign-in and models per IP, reads and
  writes per account; in D1, a daily row budget per account and a daily cap on new accounts.
  Admin panel (`src/admin.ts`, `GET /api/admin/overview`): accounts in `ADMIN_ACCOUNTS` (a Worker
  secret, never committed) with a fresh `reauth`; anyone else gets what an unknown path gets.
  Counts, sizes and days only, never item keys or contents; `accounts.last_seen` (a day, set once
  a day) and `daily_stats` (no user ids, 400 days; `src/stats.ts`) feed it. New migrations go in
  new files. Details: `worker/README.md`.

## Commands
Enter the toolchain shell first: `direnv allow` (uses `.envrc`) or `nix develop`. The flake pins
uv, Node, pnpm and make only; Python is uv-managed (`.python-version`), deps come from `uv.lock`
/ pnpm. Don't add nixpkgs Python or uv2nix packaging. Untracked files are invisible to flakes, so
`git add` new flake inputs before `nix develop`.

- `uv sync` · `uv run podia list` · `uv run podia fetch <venue>`
- Build data: `make data` (live, ~4 min, spends the shared daily LLM allowance) or
  `make data-offline` (fixtures, seconds) → `data/site/`
- Local secrets: `scripts/with-secrets <cmd>` (used by `make data`) decrypts the private
  giggle-secrets repo (cloned next to this one) with sops and this machine's age key into that
  command's environment only; setup is in that repo's README. `.env` is the fallback. Never
  decrypt or print them yourself.
- Web app: `make web-dev` (localhost:5173, serves `data/site` via a Vite plugin), `make web-build`.
- Inspect it: `make browse` (kept + left-out events with reasons; `data/` is git-ignored).
  Raw adapter output: `make fetch` then `make browse-raw`.
- Worker: `make worker-dev` (127.0.0.1:8787, local D1 and R2, `X-Giggle-Dev-User:
  alice@example.test`), `make worker-test`, `make models` (browser Kokoro files → local R2).
  Never `wrangler deploy`/`login` or `--remote` (incl. `models.mjs put --remote`) from here.
- Tests: `make test`; lint and types: `make lint` (`make format` fixes formatting).
- Re-record a venue's fixtures: `cd packages/podia && uv run podia record <venue> --max-pages 2`,
  then `PODIA_UPDATE_GOLDEN=1 uv run --group dev pytest -q tests/test_<venue>.py`

## CI and deploys
- Nightly (`.github/workflows/nightly.yml`): `build` (read-only token) builds the data with
  caches carried in artifacts; `report` (a fresh runner, the only job that can write issues and
  actions, given only this run's `health.json`) opens/closes health issues and keeps the schedule
  enabled. Artifacts (`site-data`, `pipeline-cache`) are only ever taken from this repo's own
  `schedule`/`workflow_dispatch` nightly runs on main, never by name alone (fork PRs can upload
  artifacts too); kept 90 days.
- Deploy (`deploy.yml`, only from GitHub Actions): after a green nightly or a green test run on
  main. `build` (no secrets): the newest main commit whose tests passed, the latest nightly
  `site-data`, `make web-build` → a `web-build` artifact. `deploy` (the `production`
  environment, which holds `CLOUDFLARE_DEPLOY_TOKEN` and `HEALTHCHECK_URL`): installs only the
  Worker's dependencies with `--ignore-scripts`, D1 migrations, `wrangler deploy` (retried), then
  `scripts/smoke-test.mjs` (`make smoke URL=…`: pages, security headers, data no older than 3
  days, a clip, model files, the API signed out). Never give the build job a secret.
- Actions are pinned to commit SHAs with a `# vX.Y.Z` comment; `GH_TOKEN` only on steps that run
  `gh`. Nothing younger than 7 days: Renovate's `minimumReleaseAge`, pnpm's `minimumReleaseAge`
  (drop `trustLockfile` from `pnpm-workspace.yaml` from October 2026) and uv's `exclude-newer`
  (root `pyproject.toml`), so the lockfile maintenance Renovate automerges is gated too; nixpkgs
  isn't, so `flake.lock` updates are PRs to review. uv always runs `--locked` (`UV_LOCKED=1` in
  the Makefile and workflows; after editing a pyproject, `uv lock`). Renovate automerges
  non-major updates weekly, never the voice or auth stack (review those; `kokoro-onnx` is pinned
  exactly); Python deps carry upper bounds.

## Voices
The announcers are `bf_isabella` and `bm_fable` (`ANNOUNCERS`); `announcer_for(artist_key)` gives
each artist one of them, stably, and the pipeline writes it to artists.json (`announcer`), which
the web reads (`tracks.ts` `announcerOf`).
Announcer clips (`pipeline/src/giggle_pipeline/voice.py`) use Kokoro-82M v1.0 via kokoro-onnx
(ONNX Runtime on CPU, espeak-ng from a wheel), British voices only (`bf_*`, `bm_*`, `lang="en-gb"`).
It's the `voice` extra. Model files (~350 MB, fp32) download on first use to `data/cache/models/`,
checksummed; never commit them. In CI they're kept by actions/cache (key: the pinned checksums).
- Clips are `voice/<hash>.mp3`, the hash covering spoken text, lexicon entries used, voice, model,
  speed and `RENDER_VERSION`. Existing files are never re-rendered; bump `RENDER_VERSION` when the
  audio processing changes. `test_hash_is_stable` pins the hash scheme.
- Mispronounced names go in `pronunciation.toml` (anglicised IPA in espeak's en-gb symbols;
  `uv run --package giggle-pipeline --extra voice giggle-voice-samples --phonemes "text"` shows
  espeak's version with lexicon entries spliced in, no model download), not in the blurb text.
- Tests use a fake `Synthesizer`; never download the model in tests.
- Blurbs (`blurbs.py`): 2–3 short descriptors per artist ("a Glasgow band pouring shoegaze…",
  ≤ 18 words) written by the LLM from the enrichment facts only. `problems()` rejects variants
  whose numbers, count words, capitalised names, hype or style words, or other lower-case words
  (beyond `blurbs.toml`'s neutral list) aren't in the facts, and gig details; raw answers are
  cached and re-checked each build, so tighten checks there rather than in the prompt where you
  can (prompt changes: bump `PROMPT_VERSION`). Pull a bad blurb or artist in `blurbs.toml`
  (`[blocked]`). Line-up names must appear in the listing (letters in any script); batches
  never mix venues.
- Intros (`clips.py`): "Next up, <name>, <blurb>." in the artist's announcer voice (intros look
  ahead: said after a track, a bare name could be about the one that ended). A new wording
  re-renders every clip over a few nights; `PREVIOUS_WORDINGS` keeps the old clips playing
  meanwhile. Clips render into
  `data/cache/voice/` (carried across nights in the pipeline-cache artifact; unused for 60 days →
  deleted, tracked in `referenced.json`) and only those artists.json uses are copied to
  `data/site/voice/`. Capped per night (`--max-clips` 600, `--clip-minutes` 20), first variants
  first, soonest gig first. `seconds` is the played length; the browser says the gig line live.
- Live lines (gig line, track names, "That was…") use the same model in the browser
  (`web/src/lib/voice/`, kokoro-js in a Web Worker, WebGPU): phonemes as kokoro-js makes them with
  the lexicon from `pronunciation.json` spliced in, loudness as `normalise()`. Keep those in step
  with voice.py. It renders at ~0.5–1× real time on WebGPU in Firefox, so the radio decides the
  next track's and the next artist's lines ahead and renders them (queued renders it no longer
  needs are dropped on a move); a line it couldn't prepare opens with a short "Here's <name>."
  (the presenter's `quick`).
- The browser's model files come from our origin (`/models/…`, Worker + R2), never Hugging Face
  at runtime: `model-files.json` pins the HF commit, sizes and SHA-256 (fp32, q8, the two
  announcer voices); `model-source.ts` points transformers.js there, rewrites kokoro-js's
  hardcoded voice URL and checks every download against the pinned size and SHA-256 as it streams
  (`verified`, `sha256.ts`), so a wrong file is never cached. `make models` downloads them
  (checked) to `data/cache/web-models/` — not the pipeline's `data/cache/models/` — and loads the
  local R2; without it, `vite dev` falls back to Hugging Face. The user uploads to the real
  bucket (`worker/README.md`); never do it here.

## Local stack
`make dev` runs it all (web on localhost:5173, API on :8787). Sign in on `/account` with a
passkey (they work on localhost), or as a fake user by visiting
`http://localhost:5173/api/dev/login?as=alice@example.test` (any email; two browsers = two users).
Browser tests can use Chromium's virtual authenticator (CDP `WebAuthn.addVirtualAuthenticator`).
Everything must run locally: `make dev` (fixtures → data, `wrangler dev` with local D1/R2,
`vite dev` proxying `/api` and `/models`), with a dev identity alongside passkeys only when
`ENVIRONMENT=dev` (the Worker must refuse it in production), and `--llm fake` for offline
pipeline runs. Keep `make help` accurate.

## Rules
- The repo is public. Fixtures are committed: adapters override `redact()` so recordings contain
  nothing sensitive (Tolhuistuin's page leaks DB credentials; Paradiso's API key is replaced with
  `REDACTED-TOKEN`). Never commit a raw venue page.
- Adapters use `FetchOptions.since`, never `date.today()`, so fixtures replay deterministically.
- Prefer structured sources (APIs, feeds, embedded JSON) over HTML; don't guess missing fields.
- Scope decisions live in `pipeline/src/giggle_pipeline/scope.toml`, not in podia: no club/EDM
  nights, classical, tribute acts, non-music or children's events; no arenas (AFAS Live, Ziggo
  Dome). When changing rules, add a case to `pipeline/tests/test_scope.py`.
- YouTube Music only; Spotify on hold.
- Svelte: never put player/SDK objects in `$state`; use private fields or `$state.raw`.
- Links from data go through `externalHref` (`web/src/lib/data/slugs.ts`), pictures through
  `imageSrc` (`web/src/lib/data/image-hosts.ts`), whose host list also makes the CSP's img-src: a
  new venue's image host goes there. The pipeline also writes http(s) URLs only. Keys from data or
  the URL index prototype-free objects or go through `own()` (`lib/data/own.ts`).
- Security headers come from `web/static/_headers` and the page CSP from `kit.csp` in
  `web/vite.config.ts`. When the web app starts using a new outside origin (script, frame, font,
  fetch, image), add it there and check the browser console for CSP violations. Fonts are
  self-hosted (Fontsource, imported in app.css); nothing loads from Google Fonts.
