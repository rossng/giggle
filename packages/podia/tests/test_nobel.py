from conftest import replay_events
from podia import Availability


def test_nobel(golden):
    events = replay_events("nobel")
    assert len(events) >= 80
    assert all(e.start.utcoffset() is not None for e in events)
    # The date comes from the URL slug, not the node creation date in <time datetime>.
    audrey = next(e for e in events if e.source_id == "audrey-horne-13-oct-2026")
    assert (audrey.start.month, audrey.start.day) == (10, 13)
    assert all(e.genres for e in events)
    assert {"Concert", "Clubnacht"} <= {c for e in events for c in e.categories}
    assert any(e.availability is Availability.SOLD_OUT for e in events)
    assert any(e.availability is Availability.FREE for e in events)
    # The first events have their detail page fetched: time, room, price and tickets.
    detailed = [e for e in events if e.room]
    assert len(detailed) == 10
    assert all(e.start.hour > 0 and e.price and e.price.min_eur for e in detailed)
    assert any("zaal" in (e.room or "").lower() for e in detailed)
    assert any(e.ticket_url and "eventix" in e.ticket_url for e in detailed)
    assert any(e.support for e in detailed)
    golden("nobel", events)
