from datetime import date

from conftest import replay_events
from podia import Availability


def test_qfactory(golden):
    events = replay_events("qfactory")
    assert len(events) >= 30
    # The page has past events too; only upcoming ones are kept.
    assert all(e.start.date() >= date(2026, 9, 27) for e in events)
    assert all(e.start.utcoffset() is not None for e in events)
    assert {"Grote Zaal", "Kleine Zaal"} <= {e.room for e in events}
    assert "concert" in {c for e in events for c in e.categories}
    assert sum(1 for e in events if e.genres) >= len(events) - 3
    assert any(e.price and e.price.min_eur for e in events)
    assert any(e.availability is Availability.FREE for e in events)
    assert all(e.url and e.url.startswith("https://q-factory.com/nl/events/") for e in events)
    # Long descriptions arrive as separate RSC text rows; the "$<id>" references are resolved.
    assert all(e.description and not e.description.startswith("$") for e in events)
    # A stale door time (months before the show) is dropped rather than kept.
    assert all(
        e.doors is None or (e.doors.date() == e.start.date() and e.doors <= e.start) for e in events
    )
    kim = next(e for e in events if e.source_id == "kim-wilde-the-singles-tour")
    assert kim.title.startswith("Kim Wilde - The Singles Tour")
    assert (kim.price.min_eur, kim.ticket_url) == (
        44.0,
        "https://www.ticketmaster.nl/event/1429376099?brand=nl_qfactory",
    )
    golden("qfactory", events)
