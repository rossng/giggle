from datetime import datetime

from conftest import replay, replay_events
from podia import Availability, Status
from podia.model import AMSTERDAM


def test_ziggodome(golden):
    events = replay_events("ziggodome")
    assert len(events) == 100
    assert all(e.city == "Amsterdam" for e in events)
    assert [e.start for e in events] == sorted(e.start for e in events)
    # `showDate` is UTC: 19:00 on 27 October (after the clocks go back) is 20:00 here.
    placebo = next(e for e in events if e.title == "Placebo")
    assert placebo.start == datetime(2026, 10, 27, 20, 0, tzinfo=AMSTERDAM)
    assert placebo.subtitle == "30th Anniversary Tour"
    assert placebo.url == f"https://www.ziggodome.nl/events/{placebo.source_id}/"
    # Support acts in bold, with any role in front dropped.
    korn = next(e for e in events if e.title == "Korn")
    assert korn.support == ["Architects", "Pixel Grip"]
    kehlani = next(e for e in events if e.title == "Kehlani")
    assert kehlani.support == ["WASEEL", "Odeal"]
    # Genres verbatim, non-music included, for scope rules to judge.
    genres = {g for e in events for g in e.genres}
    assert {"Pop", "Rock", "Familie", "Klassiek", "Comedy", "Sport"} <= genres
    assert next(e for e in events if e.title.startswith("Aretha")).status is Status.CANCELLED
    eros = next(e for e in events if e.title == "Eros Ramazzotti")
    assert eros.status is Status.SCHEDULED and eros.extra["rescheduled"] is True
    kenshi = next(e for e in events if e.title == "Kenshi Yonezu")
    assert kenshi.availability is Availability.NOT_YET
    assert any(e.availability is Availability.SOLD_OUT for e in events)
    assert all(e.image and e.image.startswith("https://cdn.ziggodome.nl/assets/") for e in events)
    assert all(e.ticket_url and e.ticket_url.startswith("http") for e in events)
    golden("ziggodome", events)


def test_ziggodome_details(golden):
    events, detailed = replay("ziggodome")
    assert len(detailed) == 3
    sserafim, black_coffee, kiki = detailed
    assert (sserafim.doors.hour, sserafim.end.hour) == (18, 22)
    assert sserafim.price is None  # no price given
    # An expected end of "00:00" is after midnight.
    assert black_coffee.end == datetime(2026, 10, 22, 0, 0, tzinfo=AMSTERDAM)
    assert black_coffee.doors == black_coffee.start
    assert (black_coffee.price.min_eur, black_coffee.price.max_eur) == (75.17, 75.17)
    assert kiki.doors is None and kiki.price.min_eur == 69.56
    for listed, e in zip(events, detailed, strict=False):
        assert e.start == listed.start
    golden("ziggodome_details", detailed)
