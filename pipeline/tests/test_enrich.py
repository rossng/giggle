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


def test_namesake_bios_are_recognised():
    from giggle_pipeline.enrich import NAMESAKE_BIO

    assert NAMESAKE_BIO.match("There are multiple artists with this name: 1) a Dutch band")
    assert NAMESAKE_BIO.match("At least three different groups have performed under the name")
    assert not NAMESAKE_BIO.match("Nouvelle Vague is a French band led by Marc Collin")


def test_youtube_songs_only_for_artists_playing_soon(tmp_path):
    from giggle_pipeline.ytmusic import ArtistLookup

    class Lookup(ArtistLookup):
        def _lookup(self, name, key):
            return {"name": name, "browseId": key, "songs": [{"videoId": key}]}

    records = [
        gig("paradiso:1", "2026-10-01T20:00", ["Nouvelle Vague"]),
        gig("paradiso:2", "2027-03-01T20:00", ["Grote Geelstaart"]),
    ]
    youtube = Lookup(tmp_path / "yt.json", delay=0)
    artists = enrich_artists(
        records, FakeMusicBrainz(), youtube=youtube, youtube_until="2026-11-30"
    )
    assert artists["mb:mbid-nv"]["youtube"]["browseId"] == "nouvellevague"
    assert artists["name:grotegeelstaart"]["youtube"] is None


def test_lastfm_mbid_stands_in_when_musicbrainz_search_finds_nothing():
    class Lookups(FakeMusicBrainz):
        def match_by_id(self, mbid, source):
            return {"mbid": mbid, "name": "Deli Girls", "confidence": "medium", "source": source}

    class LastFM:
        def info(self, name, mbid):
            return {"name": name, "mbid": "mbid-deli" if name == "Deli Girls" else None}

        def top_tracks(self, name, mbid):
            return None

    records = [gig("occii:1", "2026-10-01T20:00", ["Deli Girls"], ["Nobody Known"])]
    artists = enrich_artists(records, Lookups(), lastfm=LastFM())
    assert artists["mb:mbid-deli"]["match"]["source"] == "lastfm"
    assert "name:nobodyknown" in artists


def test_only_confident_identities_are_described_on_air():
    from giggle_pipeline.enrich import trusted_identity

    assert trusted_identity({"match": {"confidence": "high"}})
    assert trusted_identity({"match": {"confidence": "medium", "source": "lastfm"}})
    assert not trusted_identity({"match": {"confidence": "low"}})
    assert not trusted_identity({"match": None, "lastfm": {"bio": "a Dutch techno artist"}})
