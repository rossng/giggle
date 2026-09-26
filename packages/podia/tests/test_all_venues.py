"""Checks every venue's parsed fixtures must pass, whatever the source."""

import pytest

from conftest import replay_events
from podia import all_venues


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
