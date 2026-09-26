from datetime import datetime

from giggle_pipeline.dedupe import merge_duplicates, same_show
from podia import AMSTERDAM, Event


def event(venue, title, hour=20, room=None, **kw):
    return Event(
        venue=venue,
        source_id=f"{venue}-{title}",
        title=title,
        start=datetime(2026, 10, 16, hour, 0, tzinfo=AMSTERDAM),
        room=room,
        **kw,
    )


def test_muziekgebouw_listing_of_a_bimhuis_show_is_merged_into_bimhuis():
    bimhuis = event("bimhuis", "Kiki Obi Trio", room="Zaal", doors=None)
    listed = event("muziekgebouw", "Kiki Obi Trio (live)", hour=21, room="Bimhuis", genres=["jazz"])
    kept, merged = merge_duplicates([listed, bimhuis])
    assert kept == [bimhuis]
    assert merged == [(listed, bimhuis)]


def test_different_shows_on_the_same_night_are_kept():
    a = event("paradiso", "Glass Harbour")
    b = event("paradiso", "Soft Gravel + Velvet Tram")
    assert not same_show(a, b)
    kept, _ = merge_duplicates([a, b])
    assert len(kept) == 2


def test_same_title_at_different_places_is_not_a_duplicate():
    assert not same_show(event("paradiso", "Nobu"), event("melkweg", "Nobu"))


def test_acts_at_the_same_festival_are_not_merged():
    a = event("patronaat", "Bnnyhunna • Haarlem Vinyl Festival")
    b = event("patronaat", "Janne Schra • Haarlem Vinyl Festival")
    kept, merged = merge_duplicates([a, b])
    assert len(kept) == 2 and merged == []
