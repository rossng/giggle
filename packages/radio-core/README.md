# @giggle/radio-core

The framework-agnostic engine behind giggle's gig radio. Pure TypeScript, no runtime
dependencies, no DOM access. Time (`now: Date`) and randomness (a seed or an `Rng`)
are always passed in, so everything is deterministic in tests. The Svelte app owns the
player, speech and storage; this package decides what to play and what to say.

```sh
pnpm --dir packages/radio-core test        # vitest
pnpm --dir packages/radio-core typecheck   # tsc --noEmit
```

## Modules

| Module | What it does |
| --- | --- |
| `types` | `Gig`, `Artist`, `GigsFile`, `ArtistsFile` (the pipeline's JSON as-is), `Track` `{videoId, title, album?}` and the `Player` interface (implementations live in the app). |
| `queue` | `buildQueue({gigs, tracks, now, tracksPerArtist, notForMe, artists})`: one `QueueEntry` per artist at their earliest upcoming gig, N tracks each; reports artists skipped for having no tracks or being "not for me". |
| `order` | `orderQueue(entries, "date" \| "shuffle" \| "mix", {seed, now, listenMore, history})`. Mix is a seeded Efraimidis–Spirakis weighted shuffle; `mixWeight` and `MIX` hold the weights. |
| `history` | `PlayHistory` (artistKey → epoch-ms timestamps): `recordPlay`, `pruneHistory` (60 days), `lastHeard`, `parseHistory`. |
| `session` | `snapshotSession`, `parseSession`, `restoreSession`, `filtersKey`: save a listening session and resume it against fresh data. |
| `navigation` | `nextPosition`, `previousPosition`, `nextArtistPosition`, `clampPosition`, `currentTrack` (wrapping). |
| `announcer` | `Announcer`: new-artist intros (`name` / `short` modes), gig lines, ticket notes, micro-announcements, `forTrack` to decide which. |
| `spoken` | `spokenDay` ("tonight", "on Friday the sixteenth of October"), `spokenTime` ("8.30pm"), `spokenPrice` ("about 24 euros"). |
| `titles` | `cleanSongTitle`: drops "(feat. …)", "[Official Video]", "- Remastered 2011"… |
| `picker` | `PhrasePicker`: picks a wording per slot, never the previous one. |
| `ducking` | `DuckingController`: fades the player to 20 around an announcement, safe with overlapping ones. |
| `random`, `time` | `mulberry32`, `unitHash`, `newSeed`; Amsterdam calendar helpers. |

## Decisions worth knowing

- **Mix weight** = `1 / (1 + days/4)` × 2.5 for "listen more" × 0.2 if heard in the last
  3 days (else × 0.5 within 14 days). Each artist's random draw depends only on
  `(seed, artistKey)`, so artists coming and going don't reshuffle the others.
- **Restore** keeps the played part, drops artists that vanished (position follows),
  keeps the current artist current (or moves to the next survivor, track 1), and inserts
  new artists only after the current one: by date in `date` order, at seeded random
  spots in `shuffle`, and at a depth matching their mix rank in `mix`.
- **Announcements** never contain figures in dates, decimals in prices or "€". Prices are
  said with probability 0.65, start times with 0.5 (afternoon/evening only, never for a
  00:00 "unknown" time); sold out / few left / free / not on sale always win over price.
- **Ducking** passes an `AbortSignal` to `speak`; a newer announcement aborts the older
  one and only the newest fades back up, to the volume from before the first.
