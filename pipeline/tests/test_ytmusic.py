import json

from giggle_pipeline.text import normalise
from giggle_pipeline.ytmusic import (
    FOUND_MAX_AGE,
    JUDGE_AFTER,
    MAX_CONSECUTIVE_ERRORS,
    NOT_FOUND_MAX_AGE,
    ArtistLookup,
)


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


class Clock:
    def __init__(self, t=1_000_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


def test_answers_expire_not_found_sooner_than_found(tmp_path):
    clock = Clock()
    lookup = CountingLookup(tmp_path / "yt.json", delay=0, now=clock)
    lookup.find("Nouvelle Vague")
    lookup.find("Unknown Band")
    clock.t += NOT_FOUND_MAX_AGE + 1
    lookup.find("Nouvelle Vague")
    lookup.find("Unknown Band")
    assert lookup.asked == 3, "only 'not found' was asked again"
    clock.t += FOUND_MAX_AGE
    lookup.find("Nouvelle Vague")
    assert lookup.asked == 4


def test_a_stale_answer_stands_in_when_the_lookup_fails_or_budget_is_spent(tmp_path):
    clock = Clock()
    lookup = CountingLookup(tmp_path / "yt.json", delay=0, now=clock)
    lookup.find("Nouvelle Vague")
    lookup.save()
    clock.t += FOUND_MAX_AGE + 1

    class Broken(ArtistLookup):
        def _lookup(self, name, key):
            raise RuntimeError("down")

    assert Broken(tmp_path / "yt.json", delay=0, now=clock).find("Nouvelle Vague")["browseId"]
    spent = CountingLookup(tmp_path / "yt.json", delay=0, now=clock, max_lookups=0)
    assert spent.find("Nouvelle Vague")["browseId"] == "UC1"


def test_version_1_caches_are_kept_and_renewed_gradually(tmp_path):
    names = {f"band{i}": None for i in range(50)} | {"nouvellevague": {"browseId": "UC1"}}
    (tmp_path / "yt.json").write_text(json.dumps({"version": 1, "artists": names}))
    clock = Clock()
    lookup = CountingLookup(tmp_path / "yt.json", delay=0, now=clock, max_lookups=0)
    assert lookup.find("Nouvelle Vague") == {"browseId": "UC1"}
    ages = [clock.t - lookup.cache[f"band{i}"]["fetched"] for i in range(50)]
    assert all(0 <= a <= NOT_FOUND_MAX_AGE for a in ages)
    assert len({round(a / 86400) for a in ages}) > 5, "spread over the days, not all at once"


def test_a_night_that_finds_nobody_stops_and_caches_no_misses(tmp_path):
    class Nobody(CountingLookup):
        def _lookup(self, name, key):
            self.asked = getattr(self, "asked", 0) + 1

    lookup = Nobody(tmp_path / "yt.json", delay=0)
    for i in range(30):
        lookup.find(f"Band {i}")
    assert lookup.asked == JUDGE_AFTER, "stops looking once nobody is ever found"
    assert "none of 20" in lookup.problem()
    lookup.save()
    assert CountingLookup(tmp_path / "yt.json").cache == {}


def test_a_night_with_some_matches_keeps_its_misses(tmp_path):
    lookup = CountingLookup(tmp_path / "yt.json", delay=0)
    lookup.find("Nouvelle Vague")
    for i in range(30):
        lookup.find(f"Band {i}")
    assert lookup.problem() is None
    lookup.save()
    assert len(CountingLookup(tmp_path / "yt.json").cache) == 31


def test_failures_in_a_row_stop_the_lookups(tmp_path):
    class Broken(CountingLookup):
        def _lookup(self, name, key):
            self.asked = getattr(self, "asked", 0) + 1
            raise RuntimeError("unofficial API changed")

    lookup = Broken(tmp_path / "yt.json", delay=0)
    for i in range(15):
        lookup.find(f"Band {i}")
    assert lookup.asked == MAX_CONSECUTIVE_ERRORS
    assert "in a row failed" in lookup.problem()
