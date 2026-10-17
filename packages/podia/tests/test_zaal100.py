from conftest import replay, replay_events
from podia import Availability


def test_zaal100(golden):
    events = replay_events("zaal100")
    assert len(events) >= 10
    assert all(e.start.utcoffset() is not None for e in events)
    assert all(e.url and e.url.startswith("https://zaal100.nl/event/") for e in events)
    # The year comes from the link's "20261101 …" name; the card shows day and month only.
    blues = next(e for e in events if e.source_id == "01-nov-26-abc")
    assert blues.start.isoformat() == "2026-11-01T15:00:00+01:00"
    assert blues.title == "Westside Blues"
    assert blues.extra["pretitle"] == "Amsterdam Blues Company presenteert:"
    # The lower title line carries the line-up.
    jazz = next(e for e in events if e.source_id == "20-10-26-impro-jazz")
    assert "Felicity Provan" in (jazz.subtitle or "")
    assert (jazz.price.min_eur, jazz.price.max_eur) == (5, 5)
    # Dinners keep the venue's own "Restaurant:" as their category; nothing else has one.
    dinners = [e for e in events if e.categories]
    assert dinners and all(e.categories == ["Restaurant"] for e in dinners)
    assert all(e.title.startswith("Restaurant:") for e in dinners)
    free = [e for e in events if e.title == "Oktopedians"]
    assert free and all(e.availability is Availability.FREE for e in free)
    golden("zaal100", events)


def test_zaal100_details(golden):
    events, detailed = replay("zaal100")
    assert len(detailed) == 3
    assert all(e.description for e in detailed)
    assert any(e.image and e.image.startswith("https://zaal100.nl/media/") for e in detailed)
    # Goeie Zin lists 18:00, when the doors and kitchen open; the music begins at 20:00.
    listed, goeie = next(
        (a, b) for a, b in zip(events, detailed, strict=False) if "goeie-zin" in b.source_id
    )
    assert (listed.start.hour, goeie.start.hour, goeie.doors.hour) == (18, 20, 18)
    assert "email@example.invalid" in (goeie.description or "")
    golden("zaal100_details", detailed)
