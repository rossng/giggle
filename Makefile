# Local development. `make help` lists targets.

.PHONY: help sync test lint format data data-offline browse radio fetch browse-raw web-dev web-build

help:
	@grep -E "^[a-z-]+:.*## " $(MAKEFILE_LIST) | sed "s/:.*## /\t/"

sync: ## install Python and JavaScript dependencies
	uv sync --group dev
	pnpm install --frozen-lockfile

test: ## run all tests (Python and TypeScript)
	cd packages/podia && uv run --group dev pytest -q
	cd pipeline && uv run --group dev pytest -q
	pnpm -r test

lint: ## check lint, formatting and types
	uv run --group dev ruff check packages pipeline scripts
	uv run --group dev ruff format --check packages pipeline scripts
	pnpm --dir web check
	pnpm --dir web lint
	pnpm --dir packages/radio-core typecheck

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

web-dev: ## run the web app on localhost:5173 against data/site (run `make data-offline` first if empty)
	pnpm --dir web dev --host 127.0.0.1

web-build: ## build the static web app into web/build, with the current data
	pnpm --dir web build
	mkdir -p web/build/data
	cp data/site/gigs.json data/site/artists.json web/build/data/

radio: ## rough playback preview of the next 14 days, served on localhost:8765 (Ctrl-C stops)
	uv run python scripts/radio_preview.py --days 14
	(sleep 1 && open http://localhost:8765/) &
	uv run python -m http.server 8765 --bind 127.0.0.1 --directory data/radio

fetch: ## raw podia output, unfiltered, into data/events/<venue>.jsonl (~10 min)
	mkdir -p data/events
	for v in $$(uv run podia list | cut -d' ' -f1); do \
		uv run podia fetch $$v > data/events/$$v.jsonl || echo "$$v failed"; \
	done

browse-raw: ## build data/raw.html from `make fetch` output and open it
	uv run python scripts/browse_events.py data/events/*.jsonl -o data/raw.html
	open data/raw.html

# To come: `make dev` (wrangler dev + vite dev).
