"""Checks every venue's parsed fixtures must pass, whatever the source."""

import pytest

from conftest import HERE, replay, replay_events
from podia import Replay, all_venues, get_venue


@pytest.mark.parametrize("slug", list(all_venues()))
def test_source_ids_are_unique(slug):
    # Consumers key events on (venue, source_id), e.g. to cache work per event.
    ids = [e.source_id for e in replay_events(slug)]
    duplicates = {i for i in ids if ids.count(i) > 1}
    assert not duplicates, f"{slug}: repeated source_id {sorted(duplicates)[:3]}"


@pytest.mark.parametrize("slug", list(all_venues()))
def test_events_have_title_and_city(slug):
    for e in replay_events(slug):
        assert e.title, f"{slug}/{e.source_id}: empty title"
        assert e.city, f"{slug}/{e.source_id}: no city"


@pytest.mark.parametrize("slug", [s for s, cls in all_venues().items() if not cls.has_details])
def test_default_details_return_the_event_unchanged(slug):
    # Without `has_details`, `details()` makes no request (Replay would raise) and adds nothing.
    venue = get_venue(slug)
    fetch = Replay(HERE / "fixtures" / slug)
    for e in replay_events(slug)[:5]:
        before = e.to_dict()
        detailed = venue.details(fetch, e)
        assert detailed.source_id == e.source_id
        assert detailed.to_dict() == before


@pytest.mark.parametrize("slug", [s for s, cls in all_venues().items() if cls.has_details])
def test_details_only_enrich(slug):
    # Same event, never a field emptied, and the listing's event left as it was.
    events, detailed = replay(slug)
    assert detailed, f"{slug}: no event pages recorded; re-record with `podia record`"
    fresh = replay_events(slug)
    for listed, e, untouched in zip(events, detailed, fresh, strict=False):
        assert (e.venue, e.source_id) == (listed.venue, listed.source_id)
        assert listed.to_dict() == untouched.to_dict()
        after = e.to_dict()
        for name, value in listed.to_dict().items():
            if value not in (None, [], {}):
                assert after[name] not in (None, [], {}), f"{slug}/{e.source_id}: {name} emptied"
