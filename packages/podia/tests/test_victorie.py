from conftest import replay, replay_events
from podia import Availability


def test_victorie(golden):
    events = replay_events("victorie")
    assert len(events) >= 50
    assert all(e.start.utcoffset() is not None for e in events)
    assert {"live", "dance"} <= {c for e in events for c in e.categories}
    by_title = {e.title: e for e in events}
    # The programme's times are shifted by Amsterdam's offset; read in UTC they're right.
    assert by_title["Dotan"].start.isoformat() == "2026-10-21T19:50:00+02:00"
    # A club night at 23:00 on the 27th is listed as midnight on the 28th.
    assert by_title["PIÑA"].start.isoformat() == "2026-11-27T23:00:00+01:00"
    # "Victorie on Tour" shows in churches around Alkmaar and festivals elsewhere are left out.
    assert not any(e.title.startswith(("Kids but Taller", "Knives Out")) for e in events)
    assert by_title["Dotan"].availability is Availability.FEW_LEFT
    assert {Availability.ON_SALE, Availability.SOLD_OUT, Availability.FREE} <= {
        e.availability for e in events
    }
    free = [e for e in events if e.availability is Availability.FREE]
    assert all(e.price and e.price.max_eur == 0 for e in free)
    assert all(
        e.url and e.url.startswith("https://www.podiumvictorie.nl/programma/") for e in events
    )
    images = [e.image for e in events if e.image]
    assert len(images) >= len(events) - 3
    assert all(i.startswith("https://www.podiumvictorie.nl/app/uploads/") for i in images)
    golden("victorie", events)


def test_victorie_details(golden):
    events, detailed = replay("victorie")
    assert len(detailed) == 3
    for listed, e in zip(events, detailed, strict=False):
        assert e.start == listed.start
        assert e.room and e.price and e.ticket_url and e.description
        assert e.doors and e.doors <= e.start
    club, quiz, sessions = detailed
    assert quiz.start.isoformat() == "2026-10-18T13:00:00+02:00"
    assert (quiz.doors.hour, quiz.doors.minute) == (12, 15)
    assert (sessions.room, sessions.price.min_eur, sessions.price.max_eur) == (
        "Kleine Zaal",
        21,
        26,
    )
    assert club.ticket_url.startswith("https://tickets.podiumvictorie.nl/")
    golden("victorie_details", detailed)
