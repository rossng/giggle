import json
from contextlib import nullcontext
from dataclasses import replace
from datetime import datetime, timedelta

import pytest

from giggle_pipeline.cache import Cache
from giggle_pipeline.collect import VenueResult
from giggle_pipeline.details import DetailCounts, _apply, _entry, fetch_details
from podia import AMSTERDAM, Availability, Event, Price, VenueInfo
from podia.http import Response
from podia.venue import Venue

NOW = datetime(2026, 9, 26, 12, 0, tzinfo=AMSTERDAM)
DAY = timedelta(days=1)


class FakeVenue(Venue):
    """Listing: date-only events. Page (JSON): time, room, price; `fail` raises."""

    info = VenueInfo(slug="fake", name="Fake", city="Amsterdam", website="https://fake.test")
    has_details = True

    def events(self, fetch, options=None):
        raise NotImplementedError

    def details(self, fetch, event):
        r = fetch.get(event.url)
        r.raise_for_status()
        page = r.json()
        hour, minute = map(int, page["time"].split(":"))
        return replace(
            event,
            start=event.start.replace(hour=hour, minute=minute),
            room=page["room"],
            price=Price(page["price"], page["price"], f"€ {page['price']}"),
            availability=Availability.ON_SALE,
            extra={**event.extra, "time_known": True},
        )


class Plain(FakeVenue):
    info = VenueInfo(slug="plain", name="Plain", city="Amsterdam", website="https://plain.test")
    has_details = False


class FakeFetcher:
    def __init__(self, fail=()):
        self.calls: list[str] = []
        self.fail = set(fail)
        self.rooms: dict[str, str] = {}

    def get(self, url, *, params=None, headers=None):
        self.calls.append(url)
        slug = url.rsplit("/", 1)[-1]
        if slug in self.fail:
            return Response(url, 503, "")
        body = {"time": "20:30", "room": self.rooms.get(slug, "Zaal"), "price": 12.5}
        return Response(url, 200, json.dumps(body), "application/json")

    def post(self, url, *, json_body=None, data=None, headers=None):
        raise AssertionError("no POSTs")


def listed(n: int, days: float, **changes) -> Event:
    start = datetime.combine((NOW + days * DAY).date(), datetime.min.time(), AMSTERDAM)
    event = Event(
        venue="fake",
        source_id=f"e{n}",
        title=f"Event {n}",
        start=start,
        url=f"https://fake.test/e{n}",
        extra={"time_known": False},
    )
    return replace(event, **changes)


@pytest.fixture
def cache(tmp_path):
    c = Cache(tmp_path / "cache.sqlite")
    yield c
    c.close()


def run(events, fetcher, cache, now=NOW, **kwargs):
    factory = None if fetcher is None else (lambda slug: nullcontext(fetcher))
    counts: dict[str, DetailCounts] = {}
    [result] = fetch_details(
        [VenueResult("fake", events)],
        factory,
        cache,
        venues={"fake": FakeVenue()},
        now=now,
        counts=counts,
        **kwargs,
    )
    return result.events, counts.get("fake")


def test_fetches_soonest_first_within_the_budget_then_reuses_the_cache(cache):
    events = [listed(n, days) for n, days in enumerate([9, 1, 30, 4, 2])]
    fetcher = FakeFetcher()
    out, counts = run(events, fetcher, cache, max_per_venue=3)
    assert fetcher.calls == [f"https://fake.test/e{n}" for n in (1, 4, 3)]
    assert [e.source_id for e in out] == [e.source_id for e in events]  # order kept
    assert [e.room for e in out] == [None, "Zaal", None, "Zaal", "Zaal"]
    assert (out[1].start.hour, out[1].start.minute, out[1].extra) == (20, 30, {"time_known": True})
    assert (counts.fetched, counts.cached, counts.waiting) == (3, 0, 2)
    assert events[1].room is None  # the listing's events aren't modified

    # Next night: the three are cached, the other two are fetched.
    fetcher = FakeFetcher()
    out, counts = run(events, fetcher, cache, now=NOW + DAY / 24, max_per_venue=3)
    assert fetcher.calls == ["https://fake.test/e0", "https://fake.test/e2"]
    assert all(e.room == "Zaal" and e.extra["time_known"] for e in out)
    assert (counts.fetched, counts.cached, counts.waiting) == (2, 3, 0)

    # Offline: everything from the cache, nothing fetched.
    out, counts = run(events, None, cache, now=NOW + 60 * DAY)
    assert all(e.room == "Zaal" and e.price.min_eur == 12.5 for e in out)
    assert (counts.fetched, counts.cached, counts.stale) == (0, 5, 5)


def test_offline_without_cache_keeps_the_listing(cache):
    events = [listed(1, 2)]
    out, counts = run(events, None, cache)
    assert out[0] is events[0]
    assert (counts.fetched, counts.cached, counts.waiting) == (0, 0, 1)


def test_a_changed_listing_is_fetched_again(cache):
    run([listed(1, 10)], FakeFetcher(), cache)
    fetcher = FakeFetcher()
    run([listed(1, 10)], fetcher, cache)
    assert fetcher.calls == []
    for changed in (
        listed(1, 10, title="Event 1 (extra show)"),
        listed(1, 11),  # moved to another day
        listed(1, 10, url="https://fake.test/e1-new"),
    ):
        fetcher = FakeFetcher()
        run([changed], fetcher, cache)
        assert fetcher.calls == [changed.url]


@pytest.mark.parametrize(
    ("gig_in_days", "age_days", "refetch"),
    [
        (10, 2, False),  # far off, recent enough
        (10, 15, True),  # older than max_age_days
        (2, 0.5, False),  # near, but read today
        (2, 2, True),  # near and a day or more old: sold out? time changed?
    ],
)
def test_refresh_rules(cache, gig_in_days, age_days, refetch):
    event = listed(1, gig_in_days)
    run([event], FakeFetcher(), cache, now=NOW - age_days * DAY)
    fetcher = FakeFetcher()
    fetcher.rooms["e1"] = "Kleine zaal"
    out, counts = run([event], fetcher, cache)
    assert bool(fetcher.calls) is refetch
    assert out[0].room == ("Kleine zaal" if refetch else "Zaal")


def test_stale_details_are_used_until_a_refresh_fits_the_budget(cache):
    events = [listed(1, 5), listed(2, 6)]
    run(events, FakeFetcher(), cache, now=NOW - 20 * DAY)
    events.append(listed(3, 7))
    fetcher = FakeFetcher()
    out, counts = run(events, fetcher, cache, max_per_venue=1)
    assert fetcher.calls == ["https://fake.test/e3"]  # new events before refreshes
    assert all(e.room == "Zaal" for e in out)
    assert (counts.fetched, counts.cached, counts.stale) == (1, 2, 2)


def test_past_events_are_not_fetched(cache):
    fetcher = FakeFetcher()
    out, counts = run([listed(1, -1), listed(2, 0)], fetcher, cache)
    assert fetcher.calls == ["https://fake.test/e2"]  # today's gig still counts
    assert out[0].room is None and counts.waiting == 1


def test_the_newer_listing_wins_over_cached_changes(cache):
    run([listed(1, 10)], FakeFetcher(), cache)
    sold_out = listed(1, 10, availability=Availability.SOLD_OUT)
    fetcher = FakeFetcher()
    [e], _ = run([sold_out], fetcher, cache)
    assert fetcher.calls == []
    assert e.availability is Availability.SOLD_OUT  # not the cached "on sale"
    assert e.room == "Zaal" and e.start.hour == 20  # the rest still applies


def test_failures_are_reported_and_keep_the_listing(cache, capsys):
    events = [listed(n, n) for n in range(1, 6)]
    fetcher = FakeFetcher(fail={"e1"})
    out, counts = run(events, fetcher, cache)
    assert out[0] is events[0] and all(e.room == "Zaal" for e in out[1:])
    assert (counts.fetched, counts.failed, counts.waiting) == (4, 1, 1)
    assert "fake/e1" in capsys.readouterr().err

    # A venue that keeps failing is left alone after a few pages.
    fetcher = FakeFetcher(fail={f"e{n}" for n in range(10, 20)})
    run([listed(n, 1) for n in range(10, 20)], fetcher, cache)
    assert len(fetcher.calls) == 3


def test_venues_without_details_and_failed_venues_pass_through(cache):
    plain = VenueResult("plain", [listed(1, 1, venue="plain")])
    broken = VenueResult("fake", [], error="Traceback…")
    fetcher = FakeFetcher()
    out = fetch_details(
        [plain, broken],
        lambda slug: nullcontext(fetcher),
        cache,
        venues={"plain": Plain(), "fake": FakeVenue()},
        now=NOW,
    )
    assert out == [plain, broken] and fetcher.calls == []


def test_entries_round_trip_through_json():
    before = listed(1, 3, extra={"time_known": False, "labels": ["Nieuw"]})
    after = replace(
        before,
        start=before.start.replace(hour=21),
        doors=before.start.replace(hour=20),
        room="Grote zaal",
        support=["Tar Pond"],
        price=Price(29.9, None, "Prijs vanaf: € 29,90"),
        availability=Availability.ON_SALE,
        extra={"time_known": True, "labels": ["Nieuw"], "age": "18+"},
    )
    entry = json.loads(json.dumps(_entry(before, after, NOW)))
    assert set(entry["fields"]) == {"start", "doors", "room", "support", "price", "availability"}
    assert entry["extra"] == {"time_known": [False, True], "age": [None, "18+"]}
    assert _apply(before, entry) == after
    # A label added to the listing since doesn't stop the other extras applying.
    relabelled = replace(before, extra={"time_known": False, "labels": ["Laatste tickets"]})
    assert _apply(relabelled, entry).extra == {
        "time_known": True,
        "labels": ["Laatste tickets"],
        "age": "18+",
    }
