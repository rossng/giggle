# Local development. `make help` lists targets.

.PHONY: help sync test lint format data data-offline browse fetch browse-raw

help:
	@grep -E "^[a-z-]+:.*## " $(MAKEFILE_LIST) | sed "s/:.*## /\t/"

sync: ## install Python dependencies
	uv sync --group dev

test: ## run all tests
	cd packages/podia && uv run --group dev pytest -q
	cd pipeline && uv run --group dev pytest -q

lint: ## check lint and formatting
	uv run --group dev ruff check packages pipeline scripts
	uv run --group dev ruff format --check packages pipeline scripts

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

fetch: ## raw podia output, unfiltered, into data/events/<venue>.jsonl (~10 min)
	mkdir -p data/events
	for v in $$(uv run podia list | cut -d' ' -f1); do \
		uv run podia fetch $$v > data/events/$$v.jsonl || echo "$$v failed"; \
	done

browse-raw: ## build data/raw.html from `make fetch` output and open it
	uv run python scripts/browse_events.py data/events/*.jsonl -o data/raw.html
	open data/raw.html

# To come: `make dev` (wrangler dev + vite dev).
