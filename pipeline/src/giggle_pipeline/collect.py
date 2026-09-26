"""Fetch every venue's events, live or from podia's recorded fixtures.

Venues run in parallel threads with a client each. They are different hosts, so
this keeps each site's own crawl delay while the whole run takes as long as the
slowest venue rather than the sum of all of them.
"""

from __future__ import annotations

import json
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from podia import Client, Event, FetchOptions, Replay, all_venues, get_venue


@dataclass
class VenueResult:
    venue: str
    events: list[Event] = field(default_factory=list)
    error: str | None = None
    seconds: float = 0.0


def collect_live(since: date, venues: list[str] | None = None) -> list[VenueResult]:
    def run(slug: str) -> VenueResult:
        started = time.monotonic()
        result = VenueResult(slug)
        try:
            with Client() as client:
                result.events = list(get_venue(slug).events(client, FetchOptions(since=since)))
        except Exception:
            result.error = traceback.format_exc(limit=3)
        result.seconds = round(time.monotonic() - started, 1)
        return result

    slugs = venues or list(all_venues())
    with ThreadPoolExecutor(max_workers=len(slugs)) as pool:
        return list(pool.map(run, slugs))


def collect_replay(fixtures: Path, venues: list[str] | None = None) -> list[VenueResult]:
    """Parse podia's recorded fixtures: offline, deterministic, a few events per venue."""
    results = []
    for slug in venues or list(all_venues()):
        directory = fixtures / slug
        meta = json.loads((directory / "meta.json").read_text())
        options = FetchOptions(since=date.fromisoformat(meta["since"]), max_pages=meta["max_pages"])
        result = VenueResult(slug)
        try:
            result.events = list(get_venue(slug).events(Replay(directory), options))
        except Exception:
            result.error = traceback.format_exc(limit=3)
        results.append(result)
    return results
