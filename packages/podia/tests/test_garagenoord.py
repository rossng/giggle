from conftest import replay, replay_events


def test_garagenoord(golden):
    events = replay_events("garagenoord")
    assert len(events) >= 10
    assert all(e.start.utcoffset() is not None for e in events)
    # Everything is filed under the club, and the agenda has dates only.
    assert all(e.categories == ["Club"] for e in events)
    assert all((e.start.hour, e.start.minute) == (0, 0) for e in events)
    assert all(e.extra["time_known"] is False for e in events)
    assert all(e.url and e.url.startswith("https://garagenoord.com/club/") for e in events)
    assert all(e.ticket_url and "weticket.io" in e.ticket_url for e in events)
    assert not any(e.performers or e.description or e.image for e in events)
    golden("garagenoord", events)


def test_garagenoord_details(golden):
    events, detailed = replay("garagenoord")
    assert len(detailed) == 4
    for listed, e in zip(events, detailed, strict=False):
        assert e.start == listed.start and e.image
        assert e.image.startswith("https://garagenoord.com/media/pages/club/")
    culvert, firewire, ape, _ = detailed
    assert culvert.description and culvert.performers[:2] == ["Mick Harris", "Vanja Rakic"]
    # The punk night's "Listen here" links are its bands.
    assert ape.title == "APE"
    assert ape.performers[:3] == ["Bleedroot", "Cest qui?", "The Protos"]
    # An event page without text or links adds just the poster.
    assert not firewire.description and not firewire.performers
    golden("garagenoord_details", detailed)
