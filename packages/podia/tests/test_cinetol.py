from conftest import replay_events
from podia import Availability


def test_cinetol(golden):
    events = replay_events("cinetol")
    assert len(events) >= 50
    assert all(e.start.utcoffset() is not None for e in events)
    assert all(e.genres for e in events)
    assert any(e.availability is Availability.SOLD_OUT for e in events)
    # The first events have their detail page fetched: time, room, price and tickets.
    detailed = [e for e in events if e.room]
    assert len(detailed) == 10
    assert all(e.start.hour > 0 for e in detailed)
    assert any(e.price and e.price.min_eur for e in detailed)
    assert any(e.ticket_url for e in detailed)
    assert any(e.support for e in events)
    golden("cinetol", events)
