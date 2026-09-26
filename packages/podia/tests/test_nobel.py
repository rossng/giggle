from conftest import replay, replay_events
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
    # The agenda has dates only: midnight, marked as such, and nothing from event pages.
    assert all((e.start.hour, e.start.minute) == (0, 0) for e in events)
    assert all(e.extra["time_known"] is False for e in events)
    assert not any(e.room or e.price or e.ticket_url for e in events)
    golden("nobel", events)


def test_nobel_details(golden):
    events, detailed = replay("nobel")
    assert len(detailed) == 4
    for listed, e in zip(events, detailed, strict=False):
        assert e.start.date() == listed.start.date()
        assert e.extra["time_known"] is True and e.start.hour >= 12
        assert e.price and e.price.min_eur and e.description
        assert "zaal" in (e.room or "").lower()
        assert e.ticket_url and "eventix" in e.ticket_url and "_gl=" not in e.ticket_url
        assert listed.room is None and not listed.support  # untouched
    coroner = detailed[3]
    assert coroner.source_id == "coroner-01-oct-2026"
    assert (coroner.start.hour, coroner.start.minute) == (19, 30)
    assert coroner.support == ["Tar Pond", "Schizophrenia"]
    assert coroner.price.min_eur == 29.9 and coroner.price.max_eur is None  # "Prijs vanaf"
    golden("nobel_details", detailed)
