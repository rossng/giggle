from conftest import replay, replay_events
from podia import Availability


def test_cinetol(golden):
    events = replay_events("cinetol")
    assert len(events) >= 50
    assert all(e.start.utcoffset() is not None for e in events)
    assert all(e.genres for e in events)
    assert any(e.availability is Availability.SOLD_OUT for e in events)
    assert any(e.support for e in events)
    # The programme has dates only: midnight, marked as such, and nothing from event pages.
    assert all((e.start.hour, e.start.minute) == (0, 0) for e in events)
    assert all(e.extra["time_known"] is False for e in events)
    assert not any(e.room or e.price or e.ticket_url or e.doors for e in events)
    golden("cinetol", events)


def test_cinetol_details(golden):
    events, detailed = replay("cinetol")
    assert len(detailed) == 4
    for listed, e in zip(events, detailed, strict=False):
        assert e.start.date() == listed.start.date()
        assert e.extra["time_known"] is True and e.start.hour >= 12
        assert e.doors is not None and e.doors <= e.start
        assert e.room and e.ticket_url and e.description
        assert e.price and e.price.min_eur
        assert listed.room is None and listed.extra["time_known"] is False  # untouched
    shadowfall, skinflower, afar, _ = detailed
    assert shadowfall.room == "Zaal, Etage"
    assert (shadowfall.price.min_eur, shadowfall.price.max_eur) == (17, 22)
    assert skinflower.support == ["stuzzy pink"]
    assert (afar.doors.hour, afar.doors.minute) == (20, 0)
    assert (afar.start.hour, afar.start.minute) == (20, 30)
    golden("cinetol_details", detailed)
