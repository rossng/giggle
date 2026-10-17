from conftest import replay, replay_events
from podia import Availability


def test_p60(golden):
    events = replay_events("p60")
    assert len(events) >= 30
    assert all(e.city == "Amstelveen" and e.start.utcoffset() is not None for e in events)
    assert [e.start for e in events] == sorted(e.start for e in events)
    # Genres come from the WordPress taxonomy, verbatim; club nights say so.
    genres = {g for e in events for g in e.genres}
    assert {"Rock", "Cover / Tribute", "Club / Dance"} <= genres
    assert {c for e in events for c in e.categories} == {"concerten"}
    # The listed time is when the hall opens.
    assert all(e.doors == e.start for e in events)
    assert all(e.url and e.url.startswith("https://p60.nl/20") for e in events)
    assert all(e.image and e.image.startswith("https://p60.nl/wp-content/") for e in events)
    # The CMS's default end time (23:55) isn't an end; a stated next-morning one is.
    jett = next(e for e in events if e.title == "Jett Rebel")
    assert jett.end is None and jett.subtitle == "TRY OUT SHOW"
    assert (jett.price.min_eur, jett.price.max_eur) == (26.5, 26.5)
    assert any(e.end and e.end.date() > e.start.date() for e in events)
    # The long description repeats the short one with no space between it and the rest.
    assert "zijn! Een Jett Rebel-show" in jett.description
    golden("p60", events)


def test_p60_details(golden):
    events, detailed = replay("p60")
    assert len(detailed) == 3
    mokka, mdb, pow_ = detailed
    # Prices: every tier on the page; the ticket button leads off the site.
    assert (mokka.price.min_eur, mokka.price.max_eur) == (15, 25)
    assert mokka.ticket_url == "https://party-elite.nl/"
    assert all(e.availability is Availability.ON_SALE for e in detailed)
    # No "Show" time: the first act's; "Deuren dicht" after midnight is the next morning.
    assert (mokka.doors.hour, mokka.start.hour) == (22, 22)
    assert mokka.extra["timetable"] == [["Start MOKKA!", "22:00"], ["Deuren dicht", "00:30"]]
    assert (mdb.doors.hour, mdb.start.hour, mdb.start.minute) == (20, 20, 30)
    assert mdb.extra["timetable"][-1] == ["MDB", "21:15"]
    assert (pow_.doors.hour, pow_.start.hour) == (19, 20)
    assert pow_.ticket_url.startswith("https://heyhallyu.weticket.io/")
    golden("p60_details", detailed)
