from conftest import replay_events
from podia import Availability, Status


def test_paradiso(golden):
    events = replay_events("paradiso")
    assert len(events) >= 50
    assert all(e.start.utcoffset() is not None for e in events)
    # Only Paradiso's own rooms; Tolhuistuin, Bitterzoet etc. are left out.
    assert {e.room for e in events} >= {"Grote Zaal", "Boven Zaal"}
    assert not any(e.room and "Tolhuistuin" in e.room for e in events)
    assert any("Concert" in e.categories for e in events)
    assert any(e.genres for e in events)
    assert not any("Concert" in e.genres or "Stadspas" in e.genres for e in events)
    assert any(e.support for e in events)
    assert any(e.doors and e.doors <= e.start for e in events)
    assert any(e.availability is Availability.SOLD_OUT for e in events)
    assert any(e.status is not Status.SCHEDULED for e in events)
    assert all(e.url and e.url.startswith("https://www.paradiso.nl/") for e in events)
    golden("paradiso", events)
