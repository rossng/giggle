from giggle_pipeline.ytmusic import ArtistLookup, normalise


class CountingLookup(ArtistLookup):
    """ArtistLookup with the network replaced: knows one artist."""

    def _lookup(self, name, key):
        self.asked = getattr(self, "asked", 0) + 1
        if key == "nouvellevague":
            return {"name": "Nouvelle Vague", "browseId": "UC1", "songs": [{"videoId": "a"}]}
        return None


def test_normalise_ignores_case_accents_punctuation_and_leading_the():
    assert normalise("The Klittens") == normalise("klittens!") == "klittens"
    assert normalise("Mélanie Pain") == "melaniepain"


def test_answers_including_misses_are_cached_and_saved(tmp_path):
    lookup = CountingLookup(tmp_path / "yt.json", delay=0)
    assert lookup.find("Nouvelle Vague")["browseId"] == "UC1"
    assert lookup.find("Unknown Band") is None
    lookup.find("nouvelle vague")
    lookup.find("Unknown Band")
    assert lookup.asked == 2
    lookup.save()

    again = CountingLookup(tmp_path / "yt.json", delay=0, max_lookups=0)
    assert again.find("Nouvelle Vague")["browseId"] == "UC1"
    assert again.find("Unknown Band") is None
    assert getattr(again, "asked", 0) == 0, "answers come from the saved cache"


def test_budget_stops_lookups_without_caching(tmp_path):
    lookup = CountingLookup(tmp_path / "yt.json", delay=0, max_lookups=1)
    lookup.find("Some Band")
    assert lookup.find("Nouvelle Vague") is None
    assert "nouvellevague" not in lookup.cache, "looked up on a later run"


def test_a_failing_lookup_skips_the_artist(tmp_path):
    class Broken(ArtistLookup):
        def _lookup(self, name, key):
            raise RuntimeError("unofficial API changed")

    lookup = Broken(tmp_path / "yt.json", delay=0)
    assert lookup.find("Nouvelle Vague") is None
    assert lookup.cache == {}
