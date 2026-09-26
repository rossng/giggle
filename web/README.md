# giggle web

SvelteKit 2 + Svelte 5 single-page app, built with `@sveltejs/adapter-static` (every route
falls back to `index.html` and renders in the browser). It reads the pipeline's nightly output:
`gigs.json` and `artists.json`.

From the repo root, inside the Nix dev shell (`nix develop`, or prefix commands with
`nix develop path:. -c`):

```sh
make data-offline          # write data/site/*.json from recorded fixtures (seconds)
pnpm --dir web install
pnpm --dir web dev         # http://localhost:5173/agenda
pnpm --dir web check       # svelte-check
pnpm --dir web test        # vitest
pnpm --dir web build       # static site in web/build
pnpm --dir web preview     # serve web/build, with the data
```

## Data

In `dev` and `preview`, a small Vite plugin (`vite.config.ts`) serves `../data/site/*.json` at
`/data/*.json`; set `GIGGLE_DATA=/some/dir` to use other output. Nothing is copied into the
source tree. The build doesn't include the data: the deploy step copies
`data/site/gigs.json` and `data/site/artists.json` into `web/build/data/`.

Types for both files are in `src/lib/data/types.ts`, written by hand from the pipeline: keep
them in step when its output changes.

## Layout

- `src/lib/data/` — pure TypeScript, unit-tested: `filters.ts` (the filter model and its URL
  form, shared with the radio), `genres.ts` (venue genres and artist tags → coarse buckets),
  `slugs.ts` (URLs), `dates.ts`, `catalog.ts` (indexes the loaded data).
- `src/lib/components/` — agenda rows, poster tiles, filter panel.
- `src/routes/(app)/` — pages that need the data; its layout loads it once per visit.

## URLs

- `/agenda?days=30&from=3&city=amsterdam,utrecht&venue=paradiso&genre=indie,jazz&q=…&hide=soldout`
  (`/` redirects here). `/radio` takes the same filters plus `order=date|mix|shuffle` and `seed`.
  Defaults are left out; unknown or malformed parameters are ignored. Filter changes replace
  the history entry, page changes push one.
- `/gigs/<venue>/<venue's event id>-<title slug>`, `/artists/<name slug>--<first 8 of MBID>`
  (or `--x` without a MusicBrainz match), `/venues/<slug>`, `/board`.
