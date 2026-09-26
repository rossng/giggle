# Local development. `make help` lists targets.

.PHONY: help sync test lint format fetch browse

help:
	@grep -E "^[a-z-]+:.*## " $(MAKEFILE_LIST) | sed "s/:.*## /\t/"

sync: ## install Python dependencies
	uv sync --group dev

test: ## run all tests
	cd packages/podia && uv run --group dev pytest -q

lint: ## check lint and formatting
	uv run --group dev ruff check packages
	uv run --group dev ruff format --check packages

format: ## fix lint and formatting
	uv run --group dev ruff check --fix packages
	uv run --group dev ruff format packages

fetch: ## fetch live events from every venue into data/events/<venue>.jsonl (~10 min)
	mkdir -p data/events
	for v in $$(uv run podia list | cut -d' ' -f1); do \
		uv run podia fetch $$v > data/events/$$v.jsonl || echo "$$v failed"; \
	done

browse: ## build data/events.html from the fetched events and open it
	uv run python scripts/browse_events.py data/events/*.jsonl -o data/events.html
	open data/events.html

# To come: `make data` (pipeline, --local), `make dev` (wrangler dev + vite dev),
# `make data-offline` (pipeline from recorded fixtures, fake LLM).
