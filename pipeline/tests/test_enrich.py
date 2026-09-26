from giggle_pipeline.enrich import enrich_artists


class FakeMusicBrainz:
    """Knows two artists; everything else is unmatched."""

    known = {"ronker": "mbid-ronker", "nouvelle vague": "mbid-nv"}

    def match(self, name, genres):
        mbid = self.known.get(name.lower())
        return {"mbid": mbid, "name": name, "confidence": "high"} if mbid else None

    def details(self, mbid):
        return {"mbid": mbid, "country": "NL"}


def gig(gid, start, headliners, support=()):
    lineup = {"kind": "concert", "headliners": headliners, "support": list(support)}
    return {"id": gid, "start": start, "genres": [], "categories": [], "lineup": lineup}


def test_artists_are_keyed_by_mbid_or_name_and_collect_their_gigs():
    records = [
        gig("nobel:1", "2026-10-02T20:00", ["Ronker"], ["Grote Geelstaart"]),
        gig("paradiso:2", "2026-09-30T20:00", ["Nouvelle Vague"], ["Ronker"]),
    ]
    artists = enrich_artists(records, FakeMusicBrainz())

    assert set(artists) == {"mb:mbid-ronker", "mb:mbid-nv", "name:grotegeelstaart"}
    # Soonest gig first, so Ronker's gigs are listed in date order.
    assert artists["mb:mbid-ronker"]["gigs"] == ["paradiso:2", "nobel:1"]
    assert artists["mb:mbid-ronker"]["musicbrainz"] == {"mbid": "mbid-ronker", "country": "NL"}
    assert artists["name:grotegeelstaart"]["match"] is None
    assert records[0]["artists"] == [
        {"key": "mb:mbid-ronker", "name": "Ronker", "role": "headliner"},
        {"key": "name:grotegeelstaart", "name": "Grote Geelstaart", "role": "support"},
    ]
