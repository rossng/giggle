from conftest import replay_events
from podia import Availability, Status


def test_melkweg(golden):
    events = replay_events("melkweg")
    assert len(events) >= 100
    assert all(e.start.utcoffset() is not None for e in events)
    assert all(e.city == "Amsterdam" and e.url for e in events)
    assert any("Concert" in e.categories for e in events)
    assert any("Clubnacht" in e.categories for e in events)
    assert sum(bool(e.genres) for e in events) > len(events) // 2
    assert any(e.support for e in events)
    assert any(e.availability is Availability.SOLD_OUT for e in events)
    assert any(e.status is Status.CANCELLED for e in events)
    golden("melkweg", events)
