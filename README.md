# giggle

Upcoming-gig radio for Amsterdam and nearby: listen to the bands playing soon at local
venues, sort them into a board, and export playlists to YouTube Music.

- `packages/podia/` — venue agenda library, publishable on its own
- `pipeline/` — nightly build: collects venues, filters to giggle's scope, checks venue health
  (artist matching, enrichment and announcer voices to come)
- `web/` — SvelteKit app (to come)

Development: `nix develop` (or direnv), then `make help`. `make data-offline && make browse`
shows the pipeline's output from recorded fixtures without touching the network.

Licensed under the [Blue Oak Model License 1.0.0](LICENSE.md).
