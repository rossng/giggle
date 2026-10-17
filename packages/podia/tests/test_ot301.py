from conftest import replay, replay_events
from podia import Availability


def test_ot301(golden):
    events = replay_events("ot301")
    assert len(events) >= 40
    assert all(e.start.utcoffset() is not None for e in events)
    assert {"Concert", "Electronic music, party", "Film", "Food, kitchen"} <= {
        c for e in events for c in e.categories
    }
    # Rooms lose the listing's leading dash.
    assert {"Studios", "Café Gilde", "Ventilator Cinema"} <= {e.room for e in events}
    assert all(e.url and e.url.startswith("https://ot301.nl/agenda/") for e in events)
    by_id = {e.source_id: e for e in events}
    concert = by_id["22991"]
    assert concert.performers == ["Viva Rosa", "Combo Qazam", "Sentinel Island Disco"]
    assert (concert.price.min_eur, concert.price.max_eur) == (8, 8)
    assert concert.availability is Availability.ON_SALE
    assert concert.ticket_url == "https://amsterdamalternative.nl/tickets/22991"
    assert concert.image == "https://amsterdamalternative.nl/media/content/22487_large.jpg"
    # "Line up: TBA" names no one; "8-12" is a range.
    party = by_id["22955"]
    assert party.performers == []
    assert (by_id["22673"].price.min_eur, by_id["22673"].price.max_eur) == (8, 12)
    assert any(e.availability is Availability.FREE for e in events)
    golden("ot301", events)


def test_ot301_details(golden):
    events, detailed = replay("ot301")
    assert len(detailed) == 5
    for listed, e in zip(events, detailed, strict=False):
        assert e.description and e.end and e.end > listed.start
    concert = detailed[-1]
    assert concert.genres == ["Post-punk", "noise", "indie-rock"]
    # "Open: 20:00 - 01:00 hrs": the night ends the next day.
    assert concert.end.isoformat() == "2026-10-18T01:00:00+02:00"
    golden("ot301_details", detailed)
