import json
import time
from pathlib import Path

import httpx
import pytest

from giggle_pipeline.cache import Cache
from giggle_pipeline.musicbrainz import DETAILS_MAX_AGE, MusicBrainz, phrase

FIXTURES = Path(__file__).parent / "fixtures" / "musicbrainz"
NOUVELLE_VAGUE = "b017a7ae-e5ee-4675-bb13-c83346134971"  # the French bossa nova band

# Recorded responses (trimmed), keyed by the search query or artist path.
SEARCHES = {
    'artist:"Nouvelle Vague"': "search-nouvelle-vague.json",
    'artist:"Kaizers Orchestra"': "search-kaizers-orchestra.json",
    'artist:"Buena Vista Social"': "search-buena-vista-social.json",  # no exact name
}
ARTISTS = {NOUVELLE_VAGUE: "artist-nouvelle-vague.json"}


def fixture(name):
    return json.loads((FIXTURES / name).read_text())


class Server:
    """A fake MusicBrainz serving the fixtures; `fail` answers 503 that many times."""

    def __init__(self, fail=0, responses=None, shed=False):
        self.fail = fail
        self.shed = shed  # 503s look like MusicBrainz shedding search load
        self.responses = responses or {}
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.fail:
            self.fail -= 1
            headers = {"x-ratelimit-who": "search-shed", "retry-after": "0"} if self.shed else {}
            return httpx.Response(503, headers=headers)
        path = request.url.path.removeprefix("/ws/2/")
        query = request.url.params.get("query")
        if path == "artist" and query in self.responses:
            return httpx.Response(200, json=self.responses[query])
        if path == "artist":
            name = SEARCHES.get(query)
            return httpx.Response(200, json=fixture(name) if name else {"count": 0, "artists": []})
        mbid = path.removeprefix("artist/")
        if mbid in ARTISTS:
            return httpx.Response(200, json=fixture(ARTISTS[mbid]))
        return httpx.Response(404, json={"error": "Not Found"})


@pytest.fixture
def cache(tmp_path):
    return Cache(tmp_path / "c.sqlite")


def client(cache, server, **kwargs):
    sleeps: list[float] = []
    mb = MusicBrainz(
        cache, http=httpx.Client(transport=httpx.MockTransport(server)), sleep=sleeps.append,
        **kwargs,
    )  # fmt: skip
    return mb, sleeps


def test_namesakes_are_ranked_by_genre_overlap(cache):
    mb, _ = client(cache, Server())
    match = mb.match("Nouvelle Vague", ["jazz", "pop"])
    assert match == {
        "mbid": NOUVELLE_VAGUE,
        "name": "Nouvelle Vague",
        "disambiguation": "French bossa nova cover band",
        "namesakes": 2,
        "confidence": "high",
    }


def test_a_unique_name_is_a_confident_match(cache):
    server = Server()
    match = client(cache, server)[0].match("The Kaizers Orchestra", [])
    assert server.requests[0].url.params["query"] == 'artist:"Kaizers Orchestra"'
    assert match["name"] == "Kaizers Orchestra"
    assert (match["namesakes"], match["confidence"]) == (0, "high")


def test_without_genre_overlap_the_clearly_best_known_namesake_is_medium(cache):
    # Tags voted down to zero or below ("indie pop") don't count as overlap.
    match = client(cache, Server())[0].match("Nouvelle Vague", ["indie", "hip hop"])
    assert match["mbid"] == NOUVELLE_VAGUE  # scores 100 against 81
    assert match["confidence"] == "medium"


def test_indistinguishable_namesakes_are_low_confidence(cache):
    search = fixture("search-nouvelle-vague.json")
    for artist in search["artists"]:
        artist.pop("tags", None)
        artist["score"] = 90
    mb, _ = client(cache, Server(responses={'artist:"Nouvelle Vague"': search}))
    match = mb.match("Nouvelle Vague", ["jazz"])
    assert (match["namesakes"], match["confidence"]) == (2, "low")


def test_no_exact_name_is_no_match_and_cached(cache):
    server = Server()
    mb, _ = client(cache, server)
    assert mb.match("Buena Vista Social", ["latin"]) is None
    assert mb.match("Buena Vista Social", ["latin"]) is None
    assert len(server.requests) == 1, "the 'no match' answer is cached"


def test_names_are_escaped_in_the_query():
    assert phrase('Guns "N" Roses') == r'"Guns \"N\" Roses"'
    assert phrase("AC\\DC") == r'"AC\\DC"'


def test_quotes_in_names_reach_musicbrainz_escaped(cache):
    server = Server()
    client(cache, server)[0].match('Guns "N" Roses', [])
    assert server.requests[0].url.params["query"] == r'artist:"Guns \"N\" Roses"'


def test_requests_are_spaced_out(cache):
    mb, sleeps = client(cache, Server())
    mb.match("Nouvelle Vague", [])
    mb.match("Kaizers Orchestra", [])
    assert mb.requests == 2
    assert len(sleeps) == 1 and 1.0 < sleeps[0] <= 1.1


def test_503_is_retried_with_backoff(cache):
    server = Server(fail=2)
    mb, sleeps = client(cache, server)
    assert mb.match("Kaizers Orchestra", [])["confidence"] == "high"
    assert len(server.requests) == 3 and mb.requests == 3
    assert sleeps[:2] == [5, 10]


def test_a_failed_lookup_cools_down_and_carries_on(cache):
    server = Server(fail=4)  # one lookup's worth of failures, then MusicBrainz is back
    mb, sleeps = client(cache, server)
    assert mb.match("Kaizers Orchestra", []) is None
    assert sleeps == [5, 10, 20, 60], "retries, then a one-minute cool-down"
    assert not mb.unavailable
    assert mb.match("Nouvelle Vague", ["jazz"])["confidence"] == "high"


def test_repeated_outages_give_up_uncached_and_stop_asking(cache):
    server = Server(fail=100)
    mb, sleeps = client(cache, server)
    for name in ("Kaizers Orchestra", "Nouvelle Vague", "Nobu"):
        assert mb.match(name, []) is None
    assert mb.unavailable
    backoffs = [s for s in sleeps if s >= 5]  # leave out the ~1 s spacing between requests
    assert backoffs == [5, 10, 20, 60, 5, 10, 20, 120, 5, 10, 20]
    asked = len(server.requests)
    # For the rest of the run, lookups return at once instead of backing off again.
    assert mb.match("Glass Harbour", []) is None
    assert mb.details(NOUVELLE_VAGUE) is None
    assert len(server.requests) == asked

    later, _ = client(cache, Server())  # the next run tries again: nothing was cached
    assert later.match("Kaizers Orchestra", [])["confidence"] == "high"


def test_budget_is_respected_and_nothing_cached(cache):
    server = Server()
    mb, _ = client(cache, server, max_requests=1)
    assert mb.match("Kaizers Orchestra", []) is not None
    assert mb.exhausted
    assert mb.match("Nouvelle Vague", ["jazz"]) is None
    assert mb.details(NOUVELLE_VAGUE) is None
    assert len(server.requests) == 1
    assert mb.match("Kaizers Orchestra", []) is not None, "cached answers are still served"

    later, _ = client(cache, server)
    assert later.match("Nouvelle Vague", ["jazz"])["mbid"] == NOUVELLE_VAGUE


def test_retries_stop_at_the_budget(cache):
    server = Server(fail=100)
    mb, _ = client(cache, server, max_requests=2)
    assert mb.match("Kaizers Orchestra", []) is None
    assert len(server.requests) == 2
    assert not mb.unavailable, "out of budget, not proof MusicBrainz is down"


def test_details(cache):
    server = Server()
    mb, _ = client(cache, server)
    info = mb.details(NOUVELLE_VAGUE)
    assert info == {
        "mbid": NOUVELLE_VAGUE,
        "name": "Nouvelle Vague",
        "type": "Group",
        "country": "FR",
        "area": "France",
        "begin_area": "Paris",
        "begin": "2003",
        "ended": False,
        "genres": ["bossa nova", "lounge", "new wave", "jazz"],  # by votes
        "tags": ["bossa nova", "lounge", "new wave", "acoustic", "jazz"],
        "links": {
            "bandcamp": "https://nouvellevague.bandcamp.com/",
            "streaming": "https://open.spotify.com/artist/4h7NLIlg1oYdEtfQJfyto0",  # the first
            "homepage": "http://www.nouvellevaguemusic.com/",
            "wikidata": "https://www.wikidata.org/wiki/Q831029",
        },
    }
    params = server.requests[0].url.params
    assert params["inc"] == "url-rels+genres+tags" and params["fmt"] == "json"


def test_details_are_refreshed_after_max_age(cache):
    server = Server()
    mb, _ = client(cache, server)
    first = mb.details(NOUVELLE_VAGUE)
    assert mb.details(NOUVELLE_VAGUE) == first
    assert len(server.requests) == 1

    cache.db.execute(
        "UPDATE cache SET created = ? WHERE key = ?",
        (time.time() - DETAILS_MAX_AGE - 60, f"details:{NOUVELLE_VAGUE}"),
    )
    assert mb.details(NOUVELLE_VAGUE) == first
    assert len(server.requests) == 2, "stale details are fetched again"


def test_unknown_artist_details_are_none_and_not_cached(cache):
    server = Server()
    mb, _ = client(cache, server)
    assert mb.details("00000000-0000-0000-0000-000000000000") is None
    assert mb.details("00000000-0000-0000-0000-000000000000") is None
    assert len(server.requests) == 2
    assert not mb.unavailable, "a 404 is about one artist, not the service"


def test_default_client_identifies_itself(cache):
    mb = MusicBrainz(cache)
    assert mb.http.headers["User-Agent"].startswith("giggle/")


def test_shed_searches_are_retried_quickly_and_are_not_outages(cache):
    server = Server(fail=3, shed=True)  # MusicBrainz busy for three requests
    mb, sleeps = client(cache, server)
    assert mb.match("Kaizers Orchestra", [])["confidence"] == "high"
    assert [s for s in sleeps if s > 1.2] == [1.5, 2.0, 2.5], "short waits, no long backoff"
    assert mb.sheds == 3 and mb.outages == 0 and not mb.unavailable


def test_long_shedding_falls_back_to_the_usual_backoff(cache):
    server = Server(fail=100, shed=True)
    mb, sleeps = client(cache, server)
    assert mb.match("Kaizers Orchestra", []) is None
    assert [s for s in sleeps if s > 1.2] == [1.5, 2.0, 2.5, 3.0, 3.5, 3.5, 5, 10, 20, 60]
    assert mb.outages == 1


def test_match_by_id_uses_the_lookup_not_the_search(cache):
    server = Server()
    mb, _ = client(cache, server)
    match = mb.match_by_id(NOUVELLE_VAGUE, "lastfm")
    assert match["name"] == "Nouvelle Vague" and match["confidence"] == "medium"
    assert match["source"] == "lastfm"
    assert all("query" not in r.url.params for r in server.requests)
    assert mb.match_by_id("00000000-0000-0000-0000-000000000000", "lastfm") is None
