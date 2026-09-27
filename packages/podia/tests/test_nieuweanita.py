from conftest import replay_events
from podia import Availability


def _by_title(events, start):
    return [e for e in events if e.title.startswith(start)]


def test_nieuweanita(golden):
    events = replay_events("nieuweanita")
    assert len(events) >= 40
    assert all(e.start.utcoffset() is not None for e in events)
    # The grid shows "6 Oct"; the year comes from `since`, so January is next year.
    assert any(e.start.year == 2027 for e in events)
    assert {"Live!", "Comedy"} <= {c for e in events for c in e.categories}
    # Late nights end after midnight.
    assert any(e.end and e.end.date() > e.start.date() for e in events)
    assert any(e.availability is Availability.FREE for e in events)
    # Full titles come from the REST API, not the grid's shortened ones.
    assert not any(e.title.endswith("…") for e in events)

    (indie,) = _by_title(events, "Indie In Town")
    assert indie.performers == ["From2", "Frok.", "Goodbye (UK)"]
    assert (indie.doors.hour, indie.start.hour, indie.start.minute) == (20, 20, 30)
    assert (indie.price.min_eur, indie.price.max_eur) == (12.5, 13.5)  # "12.5€ presale, door 13.5"
    assert indie.ticket_url.startswith("https://www.ticketview.nl/")
    assert indie.availability is Availability.ON_SALE

    # The grid gives the door time; the page says "Deur 20.00, start 21.00".
    (mail,) = _by_title(events, "Mail For Sil")
    assert (mail.doors.hour, mail.start.hour) == (20, 21)

    # "Tickets: presale 10, door 12" (no € sign).
    (silent,) = _by_title(events, "Silent But Violent")
    assert (silent.price.min_eur, silent.price.max_eur) == (10, 12)

    # No time in the grid; the page's "start 20.30" fills it in.
    (cosey,) = _by_title(events, "Cosey Mueller")
    assert (cosey.start.hour, cosey.start.minute) == (20, 30)
    assert cosey.extra["time_known"] is True
    golden("nieuweanita", events)
