from conftest import replay_events
from podia import Availability, all_venues


def test_johancruijffarena(golden):
    events = replay_events("johancruijffarena")
    assert len(events) >= 10
    assert all(e.start.utcoffset() is not None and e.city == "Amsterdam" for e in events)
    assert [e.start for e in events] == sorted(e.start for e in events)
    # Football, a dance event and concerts, each with the venue's own type line.
    categories = {c for e in events for c in e.categories}
    assert {"Concert", "Dance", "Eredivisie", "Oranje"} <= categories
    assert all(len(e.categories) == 1 for e in events)
    concerts = [e for e in events if e.categories == ["Concert"]]
    assert {e.title for e in concerts} >= {"Oasis Live '27", "Roxy Dekker"}
    # Two Oasis nights are two entries; a card at midnight has no known time yet.
    oasis = [e for e in concerts if e.title.startswith("Oasis")]
    assert [e.source_id for e in oasis] == ["462141", "462272"]
    assert all(e.extra == {"time_known": False} for e in oasis)
    karol = next(e for e in concerts if e.title.startswith("KAROL G"))
    assert (karol.start.hour, karol.extra) == (20, {})
    assert karol.availability is Availability.ON_SALE
    assert karol.image.startswith("https://johan-cruijff-arena.b-cdn.net/")
    assert karol.description and "KAROL G" in karol.description
    golden("johancruijffarena", events)


def test_johancruijffarena_capacity():
    assert all_venues()["johancruijffarena"].info.capacity == 55_000
