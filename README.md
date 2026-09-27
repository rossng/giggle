# giggle

Upcoming gigs in and around Amsterdam, and a radio that plays the artists: see what's on, hear
who's worth a ticket, and sort them into a board that syncs across your devices.

## Architecture

```mermaid
flowchart LR
  subgraph sources["Sources"]
    venues["Venue sites and APIs"]
    meta["MusicBrainz · Last.fm · Wikipedia"]
    ytm["YouTube Music"]
  end

  subgraph gha["GitHub Actions"]
    nightly["Nightly pipeline (Python, uv)<br/>podia venue adapters → scope rules → de-duplication<br/>LLM line-ups and blurbs → artist enrichment<br/>Kokoro announcer clips (kokoro-onnx)"]
    artifacts[("Artifacts<br/>site data · pipeline cache")]
    deploy["Deploy workflow<br/>build the web app · D1 migrations<br/>wrangler deploy · smoke test"]
  end

  ai["Cloudflare Workers AI<br/>(LLM)"]

  subgraph cf["Cloudflare"]
    worker["Worker<br/>static assets: SPA, gig data, voice clips<br/>/api: passkey sign-in, sync<br/>/models: Kokoro model files"]
    d1[("D1<br/>accounts · passkeys · sessions<br/>board · unavailable dates · plays")]
    r2[("R2<br/>Kokoro model files")]
  end

  subgraph browser["Browser"]
    spa["SvelteKit 2 + Svelte 5 SPA<br/>radio-core engine"]
    kokoro["Kokoro TTS in a Web Worker<br/>(kokoro-js, WebGPU)"]
    local[("localStorage")]
  end

  youtube["YouTube embedded player"]

  venues --> nightly
  meta --> nightly
  ytm --> nightly
  nightly <--> ai
  nightly --> artifacts --> deploy --> worker
  worker --- d1
  worker --- r2
  spa -- HTTPS --> worker
  kokoro -- model files --> worker
  spa --- local
  spa --> youtube
```

- **Every night** GitHub Actions collects the venues' agendas, keeps what's in scope, works out
  line-ups with an LLM, enriches the artists and renders the announcer's intro clips, then
  deploys the result.
- **The site** is one Cloudflare Worker: static assets for the app and the data, plus a small API
  on D1 for passkey sign-in and syncing personal data. The browser plays music through YouTube's
  embedded player and speaks the announcer's live lines with Kokoro, running locally in a Web
  Worker.

## Layout

- `packages/podia/` — venue agenda library, publishable on its own
- `pipeline/` — the nightly build (`giggle-build`)
- `packages/radio-core/` — the radio engine: queue, order, announcer text, timing (TypeScript, no
  dependencies)
- `web/` — the SvelteKit app
- `worker/` — the Cloudflare Worker, D1 migrations, deploy notes (`worker/README.md`)

## Development

`nix develop` (or direnv), then `make help`. `make dev` runs the whole stack locally (web on
localhost:5173, the Worker with a local D1 and R2 on :8787); `make data-offline` builds the data
from recorded fixtures without touching the network.

Licensed under the [Blue Oak Model License 1.0.0](LICENSE.md).
