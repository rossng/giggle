# Local development. `make help` lists targets.

# Python dependencies come from uv.lock as committed: uv never re-resolves on its own (after
# editing a pyproject.toml, run `uv lock`).
export UV_LOCKED = 1

.PHONY: help sync test lint format data data-offline browse fetch browse-raw web-dev web-build smoke dev \
	worker-migrate worker-dev worker-test models seed-dev

help:
	@grep -E "^[a-z-]+:.*## " $(MAKEFILE_LIST) | sed "s/:.*## /\t/"

sync: ## install Python and JavaScript dependencies
	uv sync --locked --group dev
	pnpm install --frozen-lockfile

test: ## run all tests (Python and TypeScript)
	cd packages/podia && uv run --group dev pytest -q
	cd pipeline && uv run --group dev pytest -q
	pnpm -r test

lint: ## check lint, formatting, types and that uv.lock is up to date
	uv lock --check
	uv run --group dev ruff check packages pipeline scripts
	uv run --group dev ruff format --check packages pipeline scripts
	pnpm --dir web check
	pnpm --dir web lint
	pnpm --dir packages/radio-core typecheck
	pnpm --dir worker typecheck

format: ## fix lint and formatting
	uv run --group dev ruff check --fix packages pipeline scripts
	uv run --group dev ruff format packages pipeline scripts

data: ## run the pipeline live into data/site (~4 min)
	uv run giggle-build --out data/site --history data/site/health-history.json

data-offline: ## run the pipeline on recorded fixtures into data/site (seconds, no network)
	uv run giggle-build --replay packages/podia/tests/fixtures --out data/site

browse: ## build data/events.html from data/site (kept and left-out events) and open it
	uv run python scripts/browse_events.py data/site -o data/events.html
	open data/events.html

web-dev: ## web app on localhost:5173 against data/site (`make data-offline` first); /api, /models → worker-dev
	pnpm --dir web dev --host 127.0.0.1

web-build: ## build the static web app into web/build, with the current data (and the clips it uses)
	pnpm --dir web build
	node web/scripts/site-data.mjs data/site web/build/data

fetch: ## raw podia output, unfiltered, into data/events/<venue>.jsonl (~10 min)
	mkdir -p data/events
	for v in $$(uv run podia list | cut -d' ' -f1); do \
		uv run podia fetch $$v > data/events/$$v.jsonl || echo "$$v failed"; \
	done

browse-raw: ## build data/raw.html from `make fetch` output and open it
	uv run python scripts/browse_events.py data/events/*.jsonl -o data/raw.html
	open data/raw.html

worker-migrate: ## apply worker/migrations to the local dev D1 (in worker/.wrangler/)
	pnpm --dir worker exec wrangler d1 migrations apply DB --local --env dev

worker-dev: worker-migrate ## run the Worker on 127.0.0.1:8787: dev identity, local D1 and R2, serves web/build
	mkdir -p web/build
	pnpm --dir worker exec wrangler dev --env dev --ip 127.0.0.1 --port 8787

seed-dev: worker-migrate ## fake accounts and 120 days of stats in the local D1, for /admin (as alice)
	node worker/scripts/seed-dev.mjs

worker-test: ## run the Worker's tests (workerd + local D1 and R2)
	pnpm --dir worker test

models: ## browser Kokoro files (pinned, SHA-256 checked, ~420 MB) → data/cache/web-models → local R2
	node worker/scripts/models.mjs put --local

smoke: ## check a deployed site: make smoke URL=https://giggle.<subdomain>.workers.dev
	node scripts/smoke-test.mjs $(URL)

dev: ## whole stack: web :5173 + API and models (wrangler dev :8787); sign in via /api/dev/login?as=alice
	@[ -f data/site/gigs.json ] || $(MAKE) data-offline
	$(MAKE) -j2 worker-dev web-dev
