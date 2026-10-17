from conftest import replay, replay_events
from podia import Availability, Status


def test_helling(golden):
    events = replay_events("helling")
    assert len(events) >= 50
    assert all(e.start.utcoffset() is not None and e.city == "Utrecht" for e in events)
    # Every event is listed under at least one type of the agenda's filter.
    assert all(e.categories for e in events)
    assert {"Concert", "Club", "Festival"} <= {c for e in events for c in e.categories}
    assert {"Tribute", "House/Techno/Disco", "Postpunk"} <= {g for e in events for g in e.genres}
    by_id = {e.source_id: e for e in events}
    # Slugs may hold underscores.
    assert "violent-vira-support-cl_audio_dj-21-11-2026" in by_id
    # The card's first clock is the door time; JSON-LD's start is "Aanvang".
    ist = by_id["ist-ist-support-echo-mesh-18-10-2026"]
    assert (ist.doors.hour, ist.doors.minute, ist.start.hour, ist.start.minute) == (19, 30, 20, 0)
    assert ist.end.hour == 23 and ist.categories == ["Concert"]
    assert (ist.price.min_eur, ist.availability) == (29.5, Availability.SOLD_OUT)
    assert ist.ticket_url.startswith("https://dehelling.stager.co/")
    assert ist.subtitle and ist.image.startswith("https://dehelling.nl/app/uploads/")
    # A club night: doors at the start (no door time), ending the next morning.
    club = by_id["set-the-bar-w-mokum-rave-massive-17-10-2026"]
    assert club.doors is None and club.categories == ["Club"]
    assert club.end.date() > club.start.date()
    # Banners mark cancelled events; JSON-LD's "SoldOut" alone doesn't make one sold out.
    assert by_id["bartofso-31-10-2026"].status is Status.CANCELLED
    assert by_id["ripe-26-02-2027"].availability is Availability.UNKNOWN
    # No performers: JSON-LD's are lower-cased slugs, often of the promoter's night.
    assert not any(e.performers for e in events)
    golden("helling", events)


def test_helling_details(golden):
    events, detailed = replay("helling")
    assert len(detailed) == 3
    for listed, e in zip(events, detailed, strict=False):
        assert e.start == listed.start
        assert e.description and len(e.description) > len(listed.subtitle or "")
    club, ist, _ = detailed
    assert club.availability is Availability.ON_SALE
    assert ist.availability is Availability.SOLD_OUT
    golden("helling_details", detailed)
