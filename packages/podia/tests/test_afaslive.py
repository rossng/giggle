from datetime import date

from conftest import replay, replay_events
from podia import Availability, get_venue
from podia.model import Status


def test_afaslive(golden):
    events = replay_events("afaslive")
    assert len(events) >= 100
    assert get_venue("afaslive").info.capacity == 6000
    assert all(e.start.date() >= date(2026, 10, 17) for e in events)
    # The listing gives the day only, except for two performances on one day.
    timed = {e.title for e in events if "time_known" not in e.extra}
    assert {"B-Brave", "Freek Vonk Live", "Russo"} <= timed
    assert len(timed) < 15
    b_brave = sorted(e.source_id for e in events if e.title == "B-Brave")
    assert b_brave == [
        "6231906-2027-05-06",
        "6231906-2027-05-07",
        "6231906-2027-05-08-1500",
        "6231906-2027-05-08-2100",
        "6231906-2027-05-09-1500",
        "6231906-2027-05-09-2100",
    ]
    # "Verplaatst!": the new date, with the struck-through old one kept.
    (carlile,) = [e for e in events if e.title == "Brandi Carlile"]
    assert carlile.status is Status.POSTPONED
    assert carlile.start.date() == date(2027, 4, 2)
    assert carlile.extra["moved_from"] == "2026-10-27"
    (hazes,) = [e for e in events if e.title == "André Hazes"]
    assert hazes.status is Status.CANCELLED and hazes.start.date() == date(2026, 11, 7)
    (guus,) = [e for e in events if e.title == "Guus Meeuwis"]
    assert guus.availability is Availability.SOLD_OUT
    assert all(e.image and e.image.startswith("https://www.afaslive.nl/files/") for e in events)
    assert all(e.ticket_url is None or e.ticket_url.startswith("https://") for e in events)
    golden("afaslive", events)


def test_afaslive_details(golden):
    events, detailed = replay("afaslive")
    assert len(detailed) == 3
    racoon, jarre, stmpd = detailed
    assert all(e.extra["time_known"] and e.description for e in detailed)
    assert (racoon.doors.hour, racoon.start.hour) == (19, 21)
    assert racoon.support == ["Josua Peter"]
    assert (racoon.price.min_eur, racoon.price.max_eur) == (55, 60)
    assert racoon.start.date() == events[0].start.date()
    assert jarre.subtitle.startswith("OXYGENE & BEYOND")
    assert (jarre.doors.hour, jarre.doors.minute, jarre.start.hour, jarre.start.minute) == (
        18, 30, 19, 40
    )  # fmt: skip
    assert stmpd.start.hour == 17 and stmpd.price.min_eur == 54.98
    golden("afaslive_details", detailed)
