from conftest import replay_events
from podia import Availability


def test_bimhuis(golden):
    events = replay_events("bimhuis")
    assert len(events) >= 50
    assert all(e.start.utcoffset() is not None for e in events)
    assert all(e.city == "Amsterdam" and e.url for e in events)
    # One event per Dutch page, none of the English duplicates.
    assert len({e.source_id for e in events}) == len(events)
    assert not any("/en/" in e.url for e in events)
    assert {e.room for e in events} <= {"Zaal", "Café", None}
    assert any(e.doors and e.doors < e.start for e in events)
    assert any(e.price and e.price.min_eur for e in events)
    assert any(e.availability is Availability.FREE for e in events)
    assert any(e.genres for e in events)
    golden("bimhuis", events)
