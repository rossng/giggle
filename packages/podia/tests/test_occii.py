from conftest import replay_events
from podia import Availability


def test_occii(golden):
    events = replay_events("occii")
    assert len(events) >= 10
    assert all(e.start.utcoffset() is not None for e in events)
    assert any("music" in e.categories for e in events)
    assert any(e.availability is Availability.FREE for e in events)
    golden("occii", events)
