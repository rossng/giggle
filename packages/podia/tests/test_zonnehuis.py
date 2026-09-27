from conftest import replay, replay_events
from podia import Availability


def test_zonnehuis(golden):
    events = replay_events("zonnehuis")
    assert len(events) >= 50
    assert all(e.start.utcoffset() is not None for e in events)
    assert {"Muziek", "Kinderen", "Rondleiding"} <= {c for e in events for c in e.categories}
    assert any(e.title.startswith("Paradiso Presenteert") for e in events)
    # A run over several days becomes one event per performance, each with its own time.
    improv = [e for e in events if e.source_id.startswith("176614-")]
    assert [e.source_id for e in improv] == ["176614-2026-10-10", "176614-2026-10-11"]
    assert all((e.start.hour, e.start.minute) == (19, 30) for e in improv)
    assert all(e.ticket_url and e.description for e in improv)
    # Single-day listings carry only what the agenda shows.
    single = [e for e in events if "-" not in e.source_id]
    assert not any(e.price or e.ticket_url or e.doors for e in single)
    golden("zonnehuis", events)


def test_zonnehuis_details(golden):
    events, detailed = replay("zonnehuis")
    assert len(detailed) == 3
    for listed, e in zip(events, detailed, strict=False):
        assert e.start == listed.start
        assert e.price and e.description
    prijs, schra, cinema = detailed
    # "€5,- entree (excl. €1,- servicekosten)": the fee isn't the price.
    assert (prijs.price.min_eur, prijs.price.max_eur) == (5, 5)
    assert (schra.price.min_eur, schra.doors.hour, schra.doors.minute) == (26.2, 19, 30)
    assert schra.ticket_url.startswith("https://www.paradiso.nl/")
    assert schra.availability is Availability.ON_SALE
    assert cinema.availability is Availability.FREE
    golden("zonnehuis_details", detailed)
