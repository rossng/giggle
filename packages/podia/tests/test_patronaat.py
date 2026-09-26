from conftest import replay_events
from podia import Availability, Status


def test_patronaat(golden):
    events = replay_events("patronaat")
    assert len(events) >= 20
    assert all(e.start.utcoffset() is not None for e in events)
    assert all(e.city == "Haarlem" and e.url for e in events)
    # Shows at PHIL and other Haarlem venues are left out.
    assert not any("PHIL" in e.title for e in events)
    assert any(e.genres for e in events)
    assert any(e.support for e in events)
    assert any(e.price and e.price.min_eur for e in events)
    assert any(e.availability is Availability.SOLD_OUT for e in events)
    assert all(e.end is None or e.end > e.start for e in events)
    assert any(e.status is Status.POSTPONED for e in events)
    golden("patronaat", events)
