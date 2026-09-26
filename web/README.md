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

The radio plays each artist's `youtube.songs` (YouTube Music). **Dev fallback**, until
`artists.json` has that field: the dev server also serves `../cache/ytmusic.json` (next to the
site data, i.e. `data/cache/ytmusic.json`) at `/data/ytmusic.json`, and
`src/lib/radio/dev-ytmusic-fallback.ts` attaches its records to artists by normalised name.
Delete that module (and its uses, marked `DEV FALLBACK`) once the pipeline writes the field.

## Layout

- `src/lib/data/` — pure TypeScript, unit-tested: `filters.ts` (the filter model and its URL
  form, shared with the radio), `genres.ts` (venue genres and artist tags → coarse buckets),
  `slugs.ts` (URLs), `dates.ts`, `catalog.ts` (indexes the loaded data).
- `src/lib/components/` — agenda rows, poster tiles, filter panel; `radio/` for the radio.
- `src/lib/radio/` — the radio around `@giggle/radio-core`:
  - `radio.svelte.ts`: the controller. UI state in `$state` fields; the YouTube player,
    `DuckingController`, `Presenter` and speaker in private fields (never in `$state`). Queue
    via `buildQueue`/`orderQueue`, moves via radio-core navigation, each track through
    `presenter.forTrack` → `planSegment` → `runSegment`, back-announcements over outros.
  - `youtube.ts`: radio-core's `Player` over the YouTube IFrame API (volume tracked locally;
    the embed must stay visible, ≥ 200 × 200 px). `app.html` sends a referrer (else error 153).
  - `speaker.ts`: the `Speaker` interface and the Web Speech implementation (British voice,
    "Daniel" if there), and `ClipSpeaker`, which plays the pipeline's Kokoro intro clip
    (`/data/voice/*.mp3`) and has Web Speech say the live gig line.
  - `station.ts` (filters + order + seed ↔ URL), `tracks.ts` (songs → tracks), `persist.ts`
    (session per station, play history, said-memory, settings), `media-session.ts`.
- `src/lib/board/board.ts` — the listener's triage (listen more / want to go / got tickets /
  not for me) by artist key, in localStorage (`giggle:board:v1`). The radio writes it; the
  Board page shows it as columns (`columns.ts`, which also works out "Been" from gig dates).
- `src/lib/sync/` — board sync with the Worker's `/api/board` (`SyncClient`, `mergeBoards`):
  last write wins per artist, deletions kept as tombstones. Signed out, the board stays local.
- `src/routes/(app)/` — pages that need the data; its layout loads it once per visit.

## Radio

Keys: space play/pause, ←/→ previous/next track, N next artist, 1/2/3/X sort the artist
(X skips them and drops them from the station). Mix (default) and Shuffle reshuffle when
picked again, writing the seed to the URL. The session is saved every few seconds and on
pagehide; a reload comes back paused at the same track and second, with a Resume button
(browsers need a click before audio). An artist counts as heard after 30 s.

## URLs

- `/agenda?days=30&from=3&city=amsterdam,utrecht&venue=paradiso&genre=indie,jazz&q=…&hide=soldout`
  (`/` redirects here). `/radio` takes the same filters plus `order=date|mix|shuffle` and `seed`.
  Defaults are left out; unknown or malformed parameters are ignored. Filter changes replace
  the history entry, page changes push one.
- `/gigs/<venue>/<venue's event id>-<title slug>`, `/artists/<name slug>--<first 8 of MBID>`
  (or `--x` without a MusicBrainz match), `/venues/<slug>`, `/board`.
