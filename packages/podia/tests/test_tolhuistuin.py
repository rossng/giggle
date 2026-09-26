import json
from pathlib import Path

from conftest import replay_events
from podia import Availability

FIXTURES = Path(__file__).parent / "fixtures" / "tolhuistuin"


def test_tolhuistuin(golden):
    events = replay_events("tolhuistuin")
    assert len(events) >= 50
    assert all(e.start.utcoffset() is not None for e in events)
    assert events == sorted(events, key=lambda e: e.start)
    assert any("Muziek" in e.categories for e in events)
    assert any(e.room == "IJzaal" for e in events)
    assert not any(e.room == "Externe locatie" for e in events)
    assert any(e.extra.get("paradiso") for e in events)
    assert any(e.availability is Availability.FREE and e.price.min_eur == 0 for e in events)
    assert any(e.price and e.price.max_eur and e.price.max_eur > e.price.min_eur for e in events)
    golden("tolhuistuin", events)


def test_tolhuistuin_fixture_has_only_whitelisted_fields():
    # The live page also serialises database settings; the fixture must never carry them.
    text = "".join(p.read_text().lower() for p in FIXTURES.iterdir())
    for word in ("password", "username", "dsn", "mysql", '"db"', "tableprefix", "eagerload"):
        assert word not in text
    index = json.loads((FIXTURES / "index.json").read_text())
    assert len(index) == 1
