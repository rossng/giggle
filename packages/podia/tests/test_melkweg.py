from datetime import datetime

from conftest import replay, replay_events
from podia import AMSTERDAM, Availability, Event, Price, Status
from podia.venues.melkweg import _url, _with_details


def test_melkweg(golden):
    events = replay_events("melkweg")
    assert len(events) >= 100
    assert all(e.start.utcoffset() is not None for e in events)
    assert all(e.city == "Amsterdam" and e.url for e in events)
    assert any("Concert" in e.categories for e in events)
    assert any("Clubnacht" in e.categories for e in events)
    assert sum(bool(e.genres) for e in events) > len(events) // 2
    assert any(e.support for e in events)
    assert any(e.availability is Availability.SOLD_OUT for e in events)
    assert any(e.status is Status.CANCELLED for e in events)
    golden("melkweg", events)


def test_melkweg_details(golden):
    events, detailed = replay("melkweg")
    assert len(detailed) == 3
    for listed, e in zip(events, detailed, strict=False):
        assert e.source_id == listed.source_id and e.title == listed.title
        assert e.room and e.ticket_url and e.description and e.price and e.price.min_eur
        assert listed.room is None and listed.doors is None  # the listing is untouched
    polyphonic, mike, nofx = detailed
    # Concert: the listing's 19:00 is the doors; the timetable gives the show at 20:00.
    assert (events[0].start.hour, events[0].start.minute) == (19, 0)
    assert polyphonic.doors == events[0].start
    assert (polyphonic.start.hour, polyphonic.start.minute) == (20, 0)
    assert polyphonic.room == "MAX"
    assert polyphonic.price == Price(28.75, 28.75, "regular € 28,75")
    assert polyphonic.ticket_url.startswith("https://www.ticketmaster.nl/")
    # "18:00 VIP doors / 19:30 Doors / 20:30 mike.": the VIP entrance is not the doors.
    assert (mike.doors.hour, mike.doors.minute, mike.start.hour) == (19, 30, 20)
    assert mike.room == "Oude Zaal"
    assert mike.price.min_eur == mike.price.max_eur == 23  # the VIP package is in `text` only
    # Film: the listing's 21:15 is the screening; doors are 15 minutes earlier.
    assert nofx.start == events[2].start and (nofx.doors.hour, nofx.doors.minute) == (21, 0)
    assert nofx.price.min_eur == 12  # not the Cineville €0
    golden("melkweg_details", detailed)


def _listed(hour: int, minute: int) -> Event:
    start = datetime(2026, 10, 3, hour, minute, tzinfo=AMSTERDAM)
    return Event(venue="melkweg", source_id="1", title="Test", start=start)


def test_melkweg_timetable_past_midnight():
    e = _with_details(
        _listed(23, 30), {"timeschedule": "23:30 Doors\r\n00:30 Headliner\r\n04:00 End"}
    )
    assert e.doors == datetime(2026, 10, 3, 23, 30, tzinfo=AMSTERDAM)
    assert e.start == datetime(2026, 10, 4, 0, 30, tzinfo=AMSTERDAM)
    assert e.end == datetime(2026, 10, 4, 4, 0, tzinfo=AMSTERDAM)


def test_melkweg_timetable_without_show_line():
    # A club afternoon: "15:00 Doors / 21:00 End" has no programme line, so the listed
    # start (the opening) stays; nothing in a line like "Legend" is read as the end.
    e = _with_details(_listed(15, 0), {"timeschedule": "15:00 Doors\r\n21:00 End"})
    assert e.start == e.doors == datetime(2026, 10, 3, 15, 0, tzinfo=AMSTERDAM)
    assert e.end == datetime(2026, 10, 3, 21, 0, tzinfo=AMSTERDAM)
    e = _with_details(_listed(19, 0), {"timeschedule": "19:00 Doors\n20:00 The Legend"})
    assert e.start.hour == 20 and e.end is None


def test_melkweg_details_without_data_keeps_the_event():
    listed = _listed(19, 30)
    assert _with_details(listed, {}).to_dict() == listed.to_dict()


def test_event_urls_stay_on_the_site():
    assert _url("/nl/agenda/band-26-09-2026") == "https://www.melkweg.nl/nl/agenda/band-26-09-2026/"
    assert _url("@evil.example/x") == "https://www.melkweg.nl/@evil.example/x/"
    assert _url("//evil.example/x") is None
    assert _url("https://evil.example/x") is None
    assert _url(None) is None
