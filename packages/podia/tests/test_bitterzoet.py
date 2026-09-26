from conftest import replay_events
from podia import Availability, Status


def test_bitterzoet(golden):
    events = replay_events("bitterzoet")
    assert len(events) >= 40
    assert all(e.start.utcoffset() is not None for e in events)
    assert all(e.start.year >= 2026 for e in events)  # "Vandaag"/"Morgen" were resolved
    assert {"concert", "clubnacht"} <= {c for e in events for c in e.categories}
    assert any(e.genres for e in events)
    assert any(e.status is Status.CANCELLED for e in events)
    # Status markers are read from the title and removed from it.
    sold_out = [e for e in events if e.availability is Availability.SOLD_OUT]
    assert sold_out and not any("[" in e.title for e in sold_out)
    assert any(e.price and e.price.min_eur for e in events)
    assert any(e.ticket_url and "paradiso" in e.ticket_url for e in events)
    assert any(e.ticket_url and "weticket" in e.ticket_url for e in events)
    # An overnight club night ends the next morning.
    assert any(e.end and e.end.date() > e.start.date() for e in events)
    golden("bitterzoet", events)
