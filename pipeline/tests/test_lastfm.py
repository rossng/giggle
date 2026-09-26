import json
import time
from pathlib import Path

import httpx

from giggle_pipeline.cache import Cache
from giggle_pipeline.lastfm import LastFM, plain_bio

FIXTURES = Path(__file__).parent / "fixtures" / "lastfm"
KEY = "0123456789abcdef-secret"
CHER = "bfcc6d75-a6a5-4bc6-8282-47aec8531818"


def fixture(name):
    return json.loads((FIXTURES / name).read_text())


def client(tmp_path, respond, api_key=KEY):
    """A LastFM whose requests go to `respond(params) -> (status, json)`, logging each."""
    seen = []

    def handler(request):
        params = dict(request.url.params)
        seen.append(params)
        status, body = respond(params)
        return httpx.Response(status, json=body)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    lastfm = LastFM(Cache(tmp_path / "c.sqlite"), api_key, http=http)
    lastfm.interval = 0
    return lastfm, seen


def serve(params):
    if params["method"] == "artist.getInfo":
        return 200, fixture("artist_getinfo.json")
    return 200, fixture("artist_gettoptracks.json")


def not_found(params):
    return 404, fixture("error_not_found.json")


def test_info_is_parsed(tmp_path):
    lastfm, seen = client(tmp_path, serve)
    info = lastfm.info("Cher", CHER)
    assert info == {
        "name": "Cher",
        "mbid": CHER,
        "url": "https://www.last.fm/music/Cher",
        "listeners": 1623844,
        "playcount": 31279514,
        "tags": ["pop", "female vocalists", "80s", "dance", "rock"],
        "similar": ["Madonna", "Kylie Minogue", "Cyndi Lauper", "Tina Turner", "Sonny & Cher"],
        "bio": "Cher (born Cherilyn Sarkisian; May 20, 1946) is an American singer & actress. "
        "Sometimes referred to as the Goddess of Pop, she has sold over 100 million records.",
    }
    assert seen[0]["mbid"] == CHER and "artist" not in seen[0], "the MBID is preferred"
    assert seen[0]["api_key"] == KEY and seen[0]["format"] == "json"
    assert lastfm.info("Cher", CHER) == info
    assert len(seen) == 1, "the second call is served from the cache"


def test_top_tracks_are_parsed(tmp_path):
    lastfm, seen = client(tmp_path, serve)
    assert lastfm.top_tracks("Cher", None) == [
        {"title": "Believe", "listeners": 1103420, "playcount": 5634245},
        {"title": "Strong Enough", "listeners": 402311, "playcount": 1234567},
    ]
    assert seen[0]["artist"] == "Cher" and seen[0]["autocorrect"] == "1"
    assert seen[0]["limit"] == "10"


def test_bio_loses_html_and_the_read_more_link():
    content = (
        'A <i>band</i> &amp; more. <a href="https://www.last.fm/x">Read more on Last.fm</a>. '
        "User-contributed text is available under the Creative Commons By-SA License"
    )
    assert plain_bio(content) == "A band & more."
    assert plain_bio(' <a href="https://www.last.fm/music/X">Read more on Last.fm</a>') is None
    assert plain_bio(None) is None


def test_unknown_mbid_falls_back_to_the_name(tmp_path):
    lastfm, seen = client(tmp_path, lambda p: not_found(p) if "mbid" in p else serve(p))
    assert lastfm.info("Cher", "00000000-0000-0000-0000-000000000000")["name"] == "Cher"
    assert [("mbid" in p, p.get("artist")) for p in seen] == [(True, None), (False, "Cher")]


def test_not_found_is_cached_for_two_weeks(tmp_path, monkeypatch):
    lastfm, seen = client(tmp_path, not_found)
    assert lastfm.info("Nobody Knows Us", None) is None
    assert lastfm.info("Nobody Knows Us", None) is None
    assert len(seen) == 1, "'not found' is cached"

    now = time.time()
    monkeypatch.setattr(time, "time", lambda: now + 13 * 86400)
    lastfm.info("Nobody Knows Us", None)
    assert len(seen) == 1
    monkeypatch.setattr(time, "time", lambda: now + 15 * 86400)
    lastfm.info("Nobody Knows Us", None)
    assert len(seen) == 2, "asked again once the 'not found' expires"


def test_found_info_expires_after_a_week(tmp_path, monkeypatch):
    lastfm, seen = client(tmp_path, serve)
    lastfm.info("Cher", CHER)
    now = time.time()
    monkeypatch.setattr(time, "time", lambda: now + 8 * 86400)
    lastfm.info("Cher", CHER)
    assert len(seen) == 2, "listener counts are refreshed weekly"
    lastfm.top_tracks("Cher", CHER)
    monkeypatch.setattr(time, "time", lambda: now + 20 * 86400)
    lastfm.top_tracks("Cher", CHER)
    assert len(seen) == 3, "top tracks keep for a month"


def test_transient_errors_are_not_cached(tmp_path):
    answers = iter([
        (429, fixture("error_rate_limit.json")),
        (503, {"message": "Service Temporarily Unavailable"}),
        (200, fixture("artist_getinfo.json")),
    ])  # fmt: skip
    lastfm, seen = client(tmp_path, lambda p: next(answers))
    assert lastfm.info("Cher", None) is None
    assert lastfm.info("Cher", None) is None
    assert lastfm.info("Cher", None)["listeners"] == 1623844
    assert len(seen) == 3


def test_network_failure_returns_none(tmp_path):
    def handler(request):
        raise httpx.ConnectError("boom", request=request)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    lastfm = LastFM(Cache(tmp_path / "c.sqlite"), KEY, http=http)
    lastfm.interval = 0
    assert lastfm.info("Cher", None) is None
    assert lastfm.top_tracks("Cher", None) is None


def test_without_a_key_nothing_is_requested(tmp_path):
    lastfm, seen = client(tmp_path, serve, api_key=None)
    assert lastfm.info("Cher", CHER) is None
    assert lastfm.top_tracks("Cher", CHER) is None
    assert seen == []


def test_the_key_is_never_written_to_disk(tmp_path):
    lastfm, seen = client(tmp_path, lambda p: not_found(p) if p["artist"] == "X" else serve(p))
    lastfm.info("Cher", None)
    lastfm.top_tracks("Cher", None)
    lastfm.info("X", None)
    lastfm.cache.close()
    assert KEY.encode() not in (tmp_path / "c.sqlite").read_bytes()


def test_request_budget(tmp_path):
    lastfm, seen = client(tmp_path, serve)
    lastfm.max_requests = 1
    assert lastfm.info("Cher", None) is not None
    assert lastfm.top_tracks("Cher", None) is None
    assert len(seen) == 1
