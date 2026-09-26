# giggle

Upcoming-gig radio for Amsterdam and nearby. Design report: https://claude.ai/artifact/6PDPXr3LtbEbPPLUxQPXWR

## Layout
- `packages/podia/` — venue agenda library, published separately (Blue Oak 1.0.0). Must stay
  app-agnostic: no artist matching, LLM calls, genre filtering or giggle-specific logic.
- `pipeline/` — nightly build (matching, enrichment, blurbs, TTS). Not yet written.
- `web/` — SvelteKit 2 + Svelte 5 static SPA. Not yet written.

## Commands
Enter the toolchain shell first: `direnv allow` (uses `.envrc`) or `nix develop`. The flake pins
uv, Node, pnpm and make only; Python is uv-managed (`.python-version`), deps come from `uv.lock`
/ pnpm. Don't add nixpkgs Python or uv2nix packaging. Untracked files are invisible to flakes, so
`git add` new flake inputs before `nix develop`.

- `uv sync` · `uv run podia list` · `uv run podia fetch <venue>`
- Inspect scraped data: `make fetch` (all venues → `data/events/*.jsonl`, ~10 min), then
  `make browse` (builds and opens `data/events.html`; `data/` is git-ignored)
- Tests: `cd packages/podia && uv run --group dev pytest -q`
- Lint: `uv run --group dev ruff check packages && uv run --group dev ruff format packages`
- Re-record a venue's fixtures: `cd packages/podia && uv run podia record <venue> --max-pages 2`,
  then `PODIA_UPDATE_GOLDEN=1 uv run --group dev pytest -q tests/test_<venue>.py`

## Local stack
Everything must run locally: `make dev` (fixtures → data, `wrangler dev` with local D1/R2,
`vite dev` proxying `/api`), with a dev identity replacing Cloudflare Access only when
`ENVIRONMENT=dev` (the Worker must refuse it in production), `--llm fake` for offline pipeline runs,
and `--local` writing to `./data/` instead of R2. Keep `make help` accurate.

## Rules
- The repo is public. Fixtures are committed: adapters override `redact()` so recordings contain
  nothing sensitive (Tolhuistuin's page leaks DB credentials; Paradiso's API key is replaced with
  `REDACTED-TOKEN`). Never commit a raw venue page.
- Adapters use `FetchOptions.since`, never `date.today()`, so fixtures replay deterministically.
- Prefer structured sources (APIs, feeds, embedded JSON) over HTML; don't guess missing fields.
- Scope decisions (applied in the pipeline, not podia): no club/EDM nights, no classical or
  contemporary classical, no arenas (AFAS Live, Ziggo Dome). YouTube Music only; Spotify on hold.
- Svelte: never put player/SDK objects in `$state`; use private fields or `$state.raw`.
