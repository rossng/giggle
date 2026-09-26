from conftest import replay_events
from podia import Availability


def test_muziekgebouw(golden):
    events = replay_events("muziekgebouw")
    assert len(events) == 40  # two agenda pages of 20
    assert all(e.start.utcoffset() is not None for e in events)
    assert all(e.room for e in events)
    assert {"Grote Zaal", "Bimhuis"} <= {e.room for e in events}
    assert any(e.availability is Availability.SOLD_OUT for e in events)
    assert any(e.availability is Availability.ON_SALE for e in events)
    # Every tariff from the price popover, e.g. Normaal € 55,00 down to Sprintplaats € 12,50.
    priced = [e for e in events if e.price and e.price.min_eur is not None]
    assert any(e.price.min_eur < e.price.max_eur for e in priced)
    assert all(e.extra.get("tariffs") for e in priced)
    assert any(e.ticket_url and "tickets.muziekgebouw.nl" in e.ticket_url for e in events)
    # Genres come from the genre pages; only the first pages of each are recorded.
    assert any("klassiek" in e.genres for e in events)
    assert any("pop" in e.genres for e in events)
    golden("muziekgebouw", events)
