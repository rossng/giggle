from conftest import replay_events
from podia import Availability


def test_ekko(golden):
    events = replay_events("ekko")
    assert len(events) >= 50
    assert all(e.start.utcoffset() is not None for e in events)
    assert all(e.city == "Utrecht" for e in events)
    assert {"Concert", "Club"} <= {c for e in events for c in e.categories}
    assert any(e.genres for e in events)
    assert any(e.support for e in events)
    assert any(e.doors and e.doors < e.start for e in events)
    assert any(e.end and e.end.date() > e.start.date() for e in events)  # club nights
    assert any(e.availability is Availability.SOLD_OUT for e in events)
    assert any(e.availability is Availability.FREE for e in events)
    assert all(e.url and e.url.startswith("https://ekko.nl/event/") for e in events)
    assert events == sorted(events, key=lambda e: e.start)
    mood = next(e for e in events if e.source_id == "mood-bored")
    assert mood.genres == ["rock"] and mood.categories == ["Concert"]
    assert (mood.price.min_eur, mood.doors.hour) == (16.5, 19)
    assert mood.extra["related_artists"] == ["Just Mustard", "bdrmm", "Wet Leg"]
    golden("ekko", events)
