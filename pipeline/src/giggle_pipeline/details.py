"""Enrich events from their own pages (podia's `Venue.details()`), a few new ones a night.

Listings are cheap; event pages cost a request each. So for venues with `has_details`,
each event's enrichment is cached and reused, and only events that are new, changed or
due a refresh are fetched, soonest first and at most `max_per_venue` per venue per run.
The rest keep their listing data (or their older cached details) until a later night.

What is cached is what `details()` changed, not the page: for each field (and each
`extra` key) that differs, the listing's value and the detailed one. Applying an entry
to tonight's listing sets a field only where the listing still has the value it had
when the page was read, so a listing that has since moved on (say, to sold out) wins.

The cache key covers the venue, the event's `source_id` and the listing fields a page
read depends on (title, start, url): a renamed, moved or re-linked event is fetched
again. An entry is reused while younger than `max_age_days`; within `NEAR_DAYS` of the
gig it is refreshed once it is a day old, for late time changes and sell-outs. Past
events are never fetched. Without a fetcher (offline builds) cached entries of any age
are used and nothing is fetched.

Failures are printed and never fail the run; after `MAX_FAILURES` in a row a venue's
remaining fetches wait for the next run.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from contextlib import AbstractContextManager
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Any

from giggle_pipeline.cache import Cache, key_for
from giggle_pipeline.collect import VenueResult
from podia import AMSTERDAM, Availability, Event, Fetcher, Price, Status, Venue, get_venue

NAMESPACE = "details"
# Bump when what a cached entry means changes (or to refetch every event page once).
VERSION = 1
NEAR_DAYS = 3  # a gig this close…
NEAR_MAX_AGE_DAYS = 1  # …has its details refreshed once they are a day old
MAX_FAILURES = 3  # consecutive failed pages before a venue's fetches wait for next run

FetchFactory = Callable[[str], AbstractContextManager[Fetcher]]


@dataclass
class DetailCounts:
    """Per venue: events enriched from pages read this run, from the cache (of which
    `stale` were due a refresh that waits for a later run), events still without details
    (`waiting`) and pages that failed."""

    fetched: int = 0
    cached: int = 0
    stale: int = 0
    waiting: int = 0
    failed: int = 0

    def __str__(self) -> str:
        parts = [f"{self.fetched} fetched", f"{self.cached} cached"]
        if self.stale:
            parts[-1] += f" ({self.stale} stale)"
        if self.waiting:
            parts.append(f"{self.waiting} waiting")
        if self.failed:
            parts.append(f"{self.failed} failed")
        return ", ".join(parts)


def cache_key(event: Event) -> str:
    """Identity of a page read: the event and the listing fields the read depends on."""
    start = event.start.isoformat()
    return key_for(NAMESPACE, VERSION, event.venue, event.source_id, event.title, start, event.url)


def fetch_details(
    results: list[VenueResult],
    fetch_factory: FetchFactory | None,
    cache: Cache,
    *,
    venues: Mapping[str, Venue] | None = None,
    max_per_venue: int = 40,
    max_age_days: float = 14,
    now: datetime | None = None,
    counts: dict[str, DetailCounts] | None = None,
) -> list[VenueResult]:
    """`results` with each detail venue's events enriched from cache or their pages.

    `fetch_factory(slug)` opens a fetcher for one venue (e.g. `lambda slug: Client()`);
    None means offline: cached details only. Venues run in parallel, one fetcher each.
    Results are new objects; event order, errors and timings are kept. Pass a dict as
    `counts` to get per-venue `DetailCounts`.
    """
    now = now or datetime.now(AMSTERDAM)
    counts = {} if counts is None else counts
    venues = dict(venues or {})
    plans: dict[str, _Plan] = {}
    for result in results:
        if not result.events:
            continue
        venue = venues.get(result.venue) or get_venue(result.venue)
        if venue.has_details:
            venues[result.venue] = venue
            plans[result.venue] = _plan(
                result.events, cache, fetch_factory, max_per_venue, max_age_days, now
            )

    fetched: dict[str, list[tuple[int, Event | Exception]]] = {}
    jobs = {slug: plan for slug, plan in plans.items() if plan.to_fetch}
    if jobs and fetch_factory is not None:
        with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
            futures = {
                slug: pool.submit(_fetch, venues[slug], fetch_factory, slug, plan)
                for slug, plan in jobs.items()
            }
            fetched = {slug: future.result() for slug, future in futures.items()}

    out: list[VenueResult] = []
    for result in results:
        plan = plans.get(result.venue)
        if plan is None:
            out.append(result)
            continue
        tally = counts.setdefault(result.venue, DetailCounts())
        events = list(result.events)
        done: set[int] = set()
        for i, outcome in fetched.get(result.venue, []):
            listed = events[i]
            if isinstance(outcome, Exception):
                tally.failed += 1
                print(f"details: {listed.venue}/{listed.source_id}: {outcome!r}", file=sys.stderr)
                continue
            cache.put(NAMESPACE, cache_key(listed), _entry(listed, outcome, now))
            events[i] = outcome
            tally.fetched += 1
            done.add(i)
        for i, listed in enumerate(result.events):
            if i in done:
                continue
            entry = plan.entries.get(i)
            if entry is None:
                tally.waiting += 1
                continue
            events[i] = _apply(listed, entry)
            tally.cached += 1
            if i in plan.stale:
                tally.stale += 1
        out.append(replace(result, events=events))
    if counts:
        print("details: " + "; ".join(f"{slug} {c}" for slug, c in counts.items()))
    return out


@dataclass
class _Plan:
    entries: dict[int, dict[str, Any]]  # event index → cached entry (fresh or stale)
    stale: set[int]  # indexes whose entry is due a refresh
    to_fetch: list[tuple[int, Event]]  # (index, listed event) to read this run, in order


def _plan(
    events: list[Event],
    cache: Cache,
    fetch_factory: FetchFactory | None,
    max_per_venue: int,
    max_age_days: float,
    now: datetime,
) -> _Plan:
    entries: dict[int, dict[str, Any]] = {}
    stale: set[int] = set()
    candidates: list[tuple[bool, datetime, int]] = []
    for i, event in enumerate(events):
        entry = cache.get(NAMESPACE, cache_key(event))
        if entry is not None:
            entries[i] = entry
            if _fresh(entry, event, now, max_age_days):
                continue
            stale.add(i)
        if event.start.date() >= now.date():  # past events aren't worth a request
            candidates.append((entry is not None, event.start, i))
    # Events with no details at all first, then refreshes; soonest first within each.
    candidates.sort()
    to_fetch = [(i, events[i]) for _, _, i in candidates[:max_per_venue]] if fetch_factory else []
    return _Plan(entries, stale, to_fetch)


def _fresh(entry: dict[str, Any], event: Event, now: datetime, max_age_days: float) -> bool:
    age = now.timestamp() - entry["fetched"]
    if age > max_age_days * 86400:
        return False
    near = event.start - now < timedelta(days=NEAR_DAYS)
    return not (near and age > NEAR_MAX_AGE_DAYS * 86400)


def _fetch(
    venue: Venue, fetch_factory: FetchFactory, slug: str, plan: _Plan
) -> list[tuple[int, Event | Exception]]:
    """Read the planned pages of one venue (in a worker thread; no cache access here)."""
    out: list[tuple[int, Event | Exception]] = []
    failures = 0
    try:
        with fetch_factory(slug) as fetch:
            for i, listed in plan.to_fetch:
                if failures >= MAX_FAILURES:
                    break
                try:
                    detailed = venue.details(fetch, listed)
                    if (detailed.venue, detailed.source_id) != (listed.venue, listed.source_id):
                        raise ValueError(f"details() returned {detailed.source_id!r}")
                except Exception as exc:
                    failures += 1
                    out.append((i, exc))
                else:
                    failures = 0
                    out.append((i, detailed))
    except Exception as exc:  # the fetcher itself failed to open or close
        print(f"details: {slug}: {exc!r}", file=sys.stderr)
    return out


# ---- cached entries ----------------------------------------------------------------

_SKIP = {"venue", "source_id", "extra"}


def _plain(event: Event) -> dict[str, Any]:
    """The event as JSON would store it, so values compare equal after a round trip."""
    return json.loads(json.dumps(event.to_dict(), ensure_ascii=False))


def _entry(listed: Event, detailed: Event, now: datetime) -> dict[str, Any]:
    """What `details()` changed: {field: [listing value, detailed value]}, and the same
    per `extra` key (None standing for a missing key)."""
    before, after = _plain(listed), _plain(detailed)
    fields = {k: [before[k], v] for k, v in after.items() if k not in _SKIP and v != before[k]}
    extra_before, extra_after = before["extra"], after["extra"]
    extra = {
        k: [extra_before.get(k), v] for k, v in extra_after.items() if extra_before.get(k) != v
    }
    return {"fetched": now.timestamp(), "fields": fields, "extra": extra}


def _apply(listed: Event, entry: dict[str, Any]) -> Event:
    """`listed` with the entry's changes, each only where the listing still has the value
    the change was made from."""
    current = _plain(listed)
    changes = {
        name: _decode(name, after)
        for name, (before, after) in entry["fields"].items()
        if name in current and current[name] == before
    }
    extra = dict(listed.extra)
    for key, (before, after) in entry["extra"].items():
        if current["extra"].get(key) == before:
            extra[key] = after
    if not changes and extra == listed.extra:
        return listed
    return replace(listed, **changes, extra=extra)


def _decode(name: str, value: Any) -> Any:
    if value is None:
        return None
    if name in ("start", "doors", "end"):
        return datetime.fromisoformat(value)
    if name == "status":
        return Status(value)
    if name == "availability":
        return Availability(value)
    if name == "price":
        return Price(**value)
    return value
