from conftest import replay_events
from podia import Availability
from podia.venues.tivolivredenburg import _record


def test_tivolivredenburg(golden):
    events = replay_events("tivolivredenburg")
    assert len(events) >= 15
    assert all(e.start.utcoffset() is not None for e in events)
    assert all(e.city == "Utrecht" and e.url for e in events)
    assert all(e.doors is None or e.doors <= e.start for e in events)
    assert any(e.doors and e.doors < e.start for e in events)
    assert any(e.room == "Grote zaal" for e in events)
    assert any(e.genres for e in events)
    assert any(e.categories for e in events)
    assert any(e.price and e.price.min_eur for e in events)
    assert any(e.availability is Availability.ON_SALE for e in events)
    assert any(e.image for e in events)
    golden("tivolivredenburg", events)


def test_record_survives_wordpress_formatting():
    # WordPress wraps the JSON in <p> tags and turns emoji into <img> tags.
    content = (
        '<p>{"production": {"id": "x", "publicTitle": "Feest", "mainContent": "Hard '
        '<img src="https://s.w.org/images/core/emoji/17.0.2/72x72/1f609.png" alt="😉" '
        'class="wp-smiley" style="height: 1em" />", "timings": [{"timingType": "Start", '
        '"timing": "2026-10-01T18:00:00.000Z", "showOnWebsite": true}, {"timingType": '
        '"Start crew TiVre", "timing": "2026-10-01T12:00:00.000Z", "showOnWebsite": false}],'
        '\n</p><p>"sold": 120}}</p>\n<p>Het bericht verscheen eerst op TivoliVredenburg.</p>'
    )
    record = _record(content)
    assert record["mainContent"] == "Hard 😉"
    assert [t["timingType"] for t in record["timings"]] == ["Start"]
    assert "sold" not in record
    assert _record("<p>{not json}</p>") is None
