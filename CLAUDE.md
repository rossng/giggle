# giggle

Upcoming-gig radio for Amsterdam and nearby. Design report: https://claude.ai/artifact/6PDPXr3LtbEbPPLUxQPXWR

## Layout
- `packages/podia/` — venue agenda library, published separately (Blue Oak 1.0.0). Must stay
  app-agnostic: no artist matching, LLM calls, genre filtering or giggle-specific logic.
- `pipeline/` — nightly build (`giggle-build`): collect venues in parallel, fetch detail pages for
  new/soon events (`details.py`), drop out-of-scope
  events by the rules in `scope.toml` (each with a reason), merge cross-venue duplicates, check
  venue health against recent runs. `giggle-issues` opens/closes one GitHub issue per broken
  venue. Then LLM line-ups (`lineup.py`), artists (`enrich.py`: MusicBrainz, Last.fm, Wikipedia,
  YouTube Music songs within 60 days), announcer blurbs (`blurbs.py`) and Kokoro clips (`clips.py`)
  for playable artists. Per-run budgets everywhere; everything cached in `data/cache/`.
- `web/` — SvelteKit 2 + Svelte 5 static SPA (adapter-static, `ssr = false`). Agenda and Radio work
  (`web/src/lib/radio/`: controller in radio.svelte.ts, YouTube Player, ClipSpeaker playing the
  pipeline's Kokoro intro clips (`/data/voice/*.mp3`), then KokoroSpeaker saying live lines with
  Kokoro in the browser (`web/src/lib/voice/`: kokoro-js in a worker, WebGPU, same voices and
  lexicon, rendered ahead) and Web Speech as its fallback, per-station session persistence,
  Media Session) and Board (triage stored by
  `web/src/lib/board/board.ts`, columns in `columns.ts`, synced by `web/src/lib/sync/`). One
  filter model (`web/src/lib/data/filters.ts`) lives in the URL; `hide=unavailable` uses the
  listener's own unavailable dates (`web/src/lib/data/unavailable.ts`, edited in the filter panel).
- `packages/radio-core/` — TypeScript radio engine (queue, Mix/Shuffle, session restore, announcer
  text, ducking): framework-free, deterministic, no runtime deps. Web imports it as
  `@giggle/radio-core` via the root pnpm workspace.
- `worker/` — Cloudflare Worker (wrangler 4, `wrangler.jsonc`): serves `web/build` as static assets
  and the per-user `/api/<collection>` on D1: board, unavailable dates, play history, one generic
  mechanism (`src/collections.ts`, `src/store.ts`, table `sync_items`: LWW per key, tombstones,
  `since` cursor; plays are immutable items, so histories merge as a union). New migrations go in
  new files. Auth is a verified Cloudflare Access JWT in production, a dev identity only with
  `--env dev` on localhost (`worker/README.md`). The web side is `web/src/lib/sync/` (`SyncClient`
  over `collection.ts`/`collections.ts`). It also serves the browser's Kokoro files at `/models/*`
  from R2 (`MODELS`), public, only those listed in `web/src/lib/voice/model-files.json`.

## Commands
Enter the toolchain shell first: `direnv allow` (uses `.envrc`) or `nix develop`. The flake pins
uv, Node, pnpm and make only; Python is uv-managed (`.python-version`), deps come from `uv.lock`
/ pnpm. Don't add nixpkgs Python or uv2nix packaging. Untracked files are invisible to flakes, so
`git add` new flake inputs before `nix develop`.

- `uv sync` · `uv run podia list` · `uv run podia fetch <venue>`
- Build data: `make data` (live, ~4 min) or `make data-offline` (fixtures, seconds) → `data/site/`
- Listen to it: `make radio` (rough playback preview on localhost:8765; YouTube embeds need a real
  http origin, not file://). Uses naive title rules + cached YouTube Music lookups
  (`data/cache/ytmusic.json`).
- Web app: `make web-dev` (localhost:5173, serves `data/site` via a Vite plugin), `make web-build`.
- Inspect it: `make browse` (kept + left-out events with reasons; `data/` is git-ignored).
  Raw adapter output: `make fetch` then `make browse-raw`.
- Worker: `make worker-dev` (127.0.0.1:8787, local D1 and R2, `X-Giggle-Dev-User:
  alice@example.test`), `make worker-test`, `make models` (browser Kokoro files → local R2).
  Never `wrangler deploy`/`login` or `--remote` (incl. `models.mjs put --remote`) from here.
- Deploy: only GitHub Actions (`.github/workflows/deploy.yml`, after a green nightly or a green
  test run on main): latest nightly `site-data` + `make web-build` + D1 migrations + `wrangler
  deploy`, then `scripts/smoke-test.mjs` (`make smoke URL=…`). Setup steps: `worker/README.md`.
- Tests: `cd packages/podia && uv run --group dev pytest -q`
- Lint: `uv run --group dev ruff check packages && uv run --group dev ruff format packages`
- Re-record a venue's fixtures: `cd packages/podia && uv run podia record <venue> --max-pages 2`,
  then `PODIA_UPDATE_GOLDEN=1 uv run --group dev pytest -q tests/test_<venue>.py`

## Voices
The announcers are `bf_isabella` and `bm_fable` (`ANNOUNCERS`); `announcer_for(artist_key)` gives
each artist one of them, stably.
Announcer clips (`pipeline/src/giggle_pipeline/voice.py`) use Kokoro-82M v1.0 via kokoro-onnx
(ONNX Runtime on CPU, espeak-ng from a wheel), British voices only (`bf_*`, `bm_*`, `lang="en-gb"`).
It's the `voice` extra: `uv run --package giggle-pipeline --extra voice giggle-voice-samples`
renders sample clips per voice to `data/voice-samples/index.html`. Model files (~350 MB, fp32)
download on first use to `data/cache/models/`, checksummed; never commit them.
- Clips are `voice/<hash>.mp3`, the hash covering spoken text, lexicon entries used, voice, model,
  speed and `RENDER_VERSION`. Existing files are never re-rendered; bump `RENDER_VERSION` when the
  audio processing changes. `test_hash_is_stable` pins the hash scheme.
- Mispronounced names go in `pronunciation.toml` (anglicised IPA in espeak's en-gb symbols;
  `giggle-voice-samples --phonemes "text"` shows espeak's version), not in the blurb text.
- Tests use a fake `Synthesizer`; never download the model in tests.
- Blurbs (`blurbs.py`): 2–3 short descriptors per artist ("a Glasgow band pouring shoegaze…",
  ≤ 18 words) written by the LLM from the enrichment facts only. `problems()` rejects variants
  whose numbers, count words, capitalised names, hype or style words aren't in the facts, and
  gig details; raw answers are cached and re-checked each build, so tighten checks there rather
  than in the prompt where you can (prompt changes: bump `PROMPT_VERSION`).
- Intros (`clips.py`): "<name>, <blurb>." in `announcer_for(key)`'s voice, to
  `data/site/voice/`; the browser says the gig line live. `seconds` is the played length. Capped
  per night, first variants first, soonest gig first. In CI the model is kept by actions/cache
  (key: the pinned checksums) and clips travel with the site-data artifact.
- Live lines (gig line, track names, "That was…") use the same model in the browser
  (`web/src/lib/voice/`): phonemes as kokoro-js makes them with the lexicon from
  `pronunciation.json` spliced in, loudness as `normalise()`, voice by `announcerFor` (TS port).
  Keep those in step with voice.py. It renders at ~0.5–1× real time on WebGPU in Firefox (about
  1.3 s per sentence plus half its length), so the radio decides the next track's and the next
  artist's lines ahead and renders them (queued renders it no longer needs are dropped on a
  move); a line it couldn't prepare opens with a short "Here's <name>." (the presenter's
  `quick`). `/lab/voice` measures it.
- The browser's model files come from our origin (`/models/…`, Worker + R2), never Hugging Face
  at runtime: `model-files.json` pins the HF commit, sizes and SHA-256 (fp32, q8, the two
  announcer voices); `model-source.ts` points transformers.js there and rewrites kokoro-js's
  hardcoded voice URL. `make models` downloads them (checked) to `data/cache/web-models/` — not
  the pipeline's `data/cache/models/` — and loads the local R2; without it, `vite dev` falls back
  to Hugging Face. The user uploads to the real bucket (`worker/README.md`); never do it here.

## Local stack
`make dev` runs it all (web on localhost:5173, API on :8787); the nav's "Sign in" signs in as
you@example.test, or visit `http://localhost:5173/api/dev/login?as=alice@example.test` (any
email; two browsers = two users). In production "Sign in" goes through Access (`/api/login`).
Everything must run locally: `make dev` (fixtures → data, `wrangler dev` with local D1/R2,
`vite dev` proxying `/api` and `/models`), with a dev identity replacing Cloudflare Access only when
`ENVIRONMENT=dev` (the Worker must refuse it in production), `--llm fake` for offline pipeline runs,
and `--local` writing to `./data/` instead of R2. Keep `make help` accurate.

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
