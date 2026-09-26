# podia

Agendas of Dutch music venues as structured events.

```console
$ podia list
$ podia fetch occii patronaat > events.jsonl
```

```python
from podia import Client, get_venue

with Client() as client:
    for event in get_venue("occii").events(client):
        print(event.start, event.title, event.price)
```

Each venue is one adapter in `podia/venues/`. Adapters read the most structured source
a venue offers (an API, iCal or RSS feed, or JSON embedded in the page) and fall back to
HTML only when nothing else exists. Every event has the same shape (`podia.Event`):
title, start/doors/end times in Europe/Amsterdam, room, city, performers and support
acts where the venue names them, genres as the venue tags them, availability, price and
ticket URL.

The client is polite by default: it honours robots.txt and crawl-delay, waits at least a
second between requests to the same host, and identifies itself with a clear User-Agent.

## Adding a venue

1. Create `src/podia/venues/<slug>.py` with a `Venue` subclass decorated with `@register`.
2. Record fixtures: `podia record <slug> --out tests/fixtures`. Override `Venue.redact` to
   trim anything sensitive or bulky before it is saved; fixtures are committed.
3. Add `tests/test_<slug>.py`; the first run writes `tests/golden/<slug>.json`.

## Licence

[Blue Oak Model License 1.0.0](LICENSE.md)
