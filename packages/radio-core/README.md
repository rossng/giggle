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
| `history` | `PlayHistory` (artistKey → epoch-ms timestamps): `recordPlay`, `pruneHistory` (60 days), `mergeHistory` (union of two devices' plays, pruned), `lastHeard`, `parseHistory`. |
| `session` | `snapshotSession`, `parseSession`, `restoreSession`, `filtersKey`: save a listening session and resume it against fresh data. |
| `navigation` | `nextPosition`, `previousPosition`, `nextArtistPosition`, `clampPosition`, `currentTrack` (wrapping). |
| `announcer` | `Announcer`: the original fixed-shape intros (`name` / `short`), gig lines, ticket notes, micro-announcements. The presenter builds on it (venue naming, song titles, ticket wordings). |
| `presenter` | `Presenter`: what a radio presenter would say — `intro`, `micro`, `backAnnounce`, `forTrack` — each a `Line` `{kind, text, seconds, facts}` inside a length budget. |
| `facts` | `factPool(...)`: the colour facts available for an artist (origin, formed, genre, similar, support, ticket, track), cleaned for speech; `cleanGenre`, `KnownArtists`. |
| `said` | `SaidMemory` (artistKey → facts said, with times): `recordSaid`, `pruneSaid`, `parseSaid`. Persist `presenter.said` next to the play history. |
| `speech` | `estimateSeconds(text, {wordsPerSecond, rate, …})`: spoken length from words and pauses. |
| `timing` | `planSegment(...)`: when to speak relative to the music (`backAnnounce` / `overIntro` / `beforeTrack` / `skip`); `runSegment(plan, {player, speak, ducking, timers})` carries it out. |
| `spoken` | `spokenDay` ("tonight", "on Friday the sixteenth of October"), `spokenTime` ("8.30pm"), `spokenPrice` ("about 24 euros"). |
| `titles` | `cleanSongTitle`: drops "(feat. …)", "[Official Video]", "- Remastered 2011", "(12" Version)", "(Deluxe Edition)", "(From "…" Soundtrack)"…; keeps named versions ("(Bicep Remix)", "(Acoustic)"). |
| `picker` | `PhrasePicker`: picks a wording per slot, never the previous one. |
| `ducking` | `DuckingController`: fades the player to 20 (or a per-call `duckTo`, e.g. 0) around an announcement, safe with overlapping ones; `level()` brings music up under the voice. |
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

## The presenter

Real presenters don't read out everything they know. Each new-artist link is the **gig**
(venue + day, sometimes the start time; always there) plus **at most one colour fact**:

| Fact | From | Sounds like |
| --- | --- | --- |
| `origin` | MusicBrainz begin area / area / country | "From Glasgow, here's Mogwai." · "They're a Norwegian band." · "Here's local band …" |
| `formed` | MusicBrainz `begin`, groups/orchestras/choirs only (a Person's `begin` is their birth) | "Here's Mogwai, together since 1995." · "They only formed in 2025." |
| `genre` | MB genres, then Last.fm tags, then MB tags (junk like "seen live", "favorites", nationalities, bare years dropped); or a clean Wikipedia description | "Here's Mogwai, a post-rock band." · "File under shoegaze." · "This is Mogwai, a Scottish post-rock band." |
| `similar` | Last.fm similar ∩ `knownArtists` (the listener's board) | "If you like Slowdive, you'll like this." · "One for Slowdive fans." |
| `support` | the gig's bill | "Here's Small Band, supporting Big Band." · "Get there early for Small Band." |
| `ticket` | notable news only: postponed, sold out, few left, free, not on sale yet; a (rounded) price rarely | "It's sold out, so keep an eye out for resale." |
| `track` | the song about to play, cleaned | "Here's Tidewater, by Mogwai." · "This one's called Tidewater." |

The fact is drawn with the seeded rng (weights in `FACT_WEIGHTS`; urgent ticket news
weighs most), from kinds **not yet said about that artist** in `presenter.said`; once all
have been said, from the half said longest ago, never the one said last. So repeat plays
rotate through what's known. It's said in one of four shapes — fact in the opening line,
after the gig, after a gig-first lead ("At Paradiso tonight: Mogwai."), or gig last — each
slot with several wordings that never repeat back to back. No data means just the gig line.
`colour` (0.85) is the chance of adding a fact at all.

**Name mode** is the gig line only ("Mogwai. Paradiso, tonight."), plus "Sold out." when it is.

### Length budgets

`estimateSeconds` assumes 2.6 words/s at rate 1.0 (times and years count as the words
they're spoken as; +0.3 s per sentence break, +0.1 s per comma); pass `speech: {rate}` or
`{wordsPerSecond}` to calibrate to the TTS voice.

| Line | Budget | When over |
| --- | --- | --- |
| New-artist link (short) | aim 5–9 s, cap 12 s | retry shorter (no start time, then "on the sixteenth of October" without the weekday), then drop the colour fact, then the shortest gig line |
| New-artist link (name) | ≤ 6 s | shorter date, shortest wording, drop "Sold out." |
| Micro-announcement | ≤ 3 s | the no-title wording, else nothing |
| Back-announcement | ≤ 6 s | "That was Mogwai.", else nothing |

A test runs thousands of lines over the sample gigs with synthetic artist records and
checks every one against these caps and for "undefined", "null", "NaN", "€" and decimals.

### Timing: `planSegment` → `runSegment`

| Mode | Used for | What happens |
| --- | --- | --- |
| `backAnnounce` | back-announcements, when the finishing track's duration is known, > 60 s and it wasn't skipped | speak ducked (20) from `duration − speech − 1.5 s`, so it ends just before the track does |
| `overIntro` | micro-announcements; links ≤ 6 s; every name-mode link | start the next track ducked and speak over its intro, then fade up |
| `beforeTrack` | links > 6 s | music at 0 while speaking; the next track starts 1 s (`leadInSeconds`) before the speech should end, comes up to 20 under the last words, and fades in over 1.5 s once the talking stops |
| `skip` | voice off; back-announcements that don't qualify; a micro less than 30 s after the last line | nothing said (the next track still starts) |

`runSegment` takes the app's `Player` (`play`, or a `startTrack` callback), a `speak(signal)`
function, the `DuckingController` and optional `timers` / `AbortSignal`; aborting cancels a
pending back-announcement or stops the speech and restores the volume. A back-announcement is
only offered (probability `back`, 0.3) for a track whose title wasn't said going in.
