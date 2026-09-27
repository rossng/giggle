import json
import time
from pathlib import Path

from giggle_pipeline.build import main, pipeline_problems
from giggle_pipeline.cache import Cache
from giggle_pipeline.clips import Intros
from giggle_pipeline.llm import FakeLLM
from giggle_pipeline.musicbrainz import MusicBrainz
from giggle_pipeline.voice import announcer_for
from giggle_pipeline.ytmusic import ArtistLookup

FIXTURES = Path(__file__).parents[2] / "packages" / "podia" / "tests" / "fixtures"


def test_offline_build_writes_consistent_outputs(tmp_path):
    # Cached YouTube Music songs for one act (with a hostile image URL), and a clip from
    # before the clip cache.
    songs = {"songs": [{"videoId": "v1", "title": "Song"}], "image": "javascript:alert(1)"}
    (tmp_path / "cache").mkdir()
    (tmp_path / "cache" / "ytmusic.json").write_text(json.dumps({
        "version": 2, "artists": {"nouvellevague": {"value": songs, "fetched": time.time()}},
    }))  # fmt: skip
    (tmp_path / "voice").mkdir()
    (tmp_path / "voice" / "0123456789abcdef0123.mp3").write_bytes(b"old clip")

    args = ["--replay", str(FIXTURES), "--out", str(tmp_path), "--llm", "fake"]
    assert main([*args, "--cache", str(tmp_path / "cache" / "cache.sqlite")]) == 0
    site = json.loads((tmp_path / "gigs.json").read_text())
    excluded = json.loads((tmp_path / "excluded.json").read_text())
    health = json.loads((tmp_path / "health.json").read_text())

    gigs = site["gigs"]
    assert len(gigs) > 100
    ids = [g["id"] for g in gigs] + [e["id"] for e in excluded]
    assert len(ids) == len(set(ids)), "every event is either kept or excluded, once"
    assert all(e["reason"] for e in excluded)
    assert set(site["venues"]) == set(health["venues"])
    assert health["problems"] == []
    assert not (tmp_path / "health-history.json").exists(), "replays don't touch the baseline"
    # The fake model names the title's acts; a festival's name isn't one ("KRONKEL FESTIVAL").
    assert all(
        g["lineup"]["headliners"] or g["lineup"]["support"]
        for g in gigs[:50]
        if "festival" not in g["title"].lower()
    )
    # The browser's Kokoro says live lines with the clips' pronunciations.
    names = json.loads((tmp_path / "pronunciation.json").read_text())["names"]
    assert {"written": "Paradiso", "ipa": "pˌaɹədˈiːzəʊ", "match_case": False} in names

    assert health["pipeline"] == []
    assert all(v["kept"] <= v["events"] for v in health["venues"].values())
    artists = json.loads((tmp_path / "artists.json").read_text())["artists"]
    [(key, playable)] = [(k, a) for k, a in artists.items() if a["youtube"]]
    assert playable["announcer"] == announcer_for(key)
    assert playable["youtube"]["image"] is None, "only http(s) URLs reach the site"
    assert not any("announcer" in a for k, a in artists.items() if k != key)
    # The old clip moved into the clip cache; the site only has the clips it uses.
    assert (tmp_path / "cache" / "voice" / "0123456789abcdef0123.mp3").read_bytes() == b"old clip"
    assert list((tmp_path / "voice").iterdir()) == []


def test_degraded_steps_become_pipeline_problems(tmp_path):
    llm = FakeLLM(lambda task, user: {})
    llm.quota_exhausted = True
    youtube = ArtistLookup(tmp_path / "yt.json")
    youtube.gave_up = "none of 20 artists found"
    mb = MusicBrainz(Cache(tmp_path / "c.sqlite"))
    mb.unavailable, mb.outages = True, 3
    intros = Intros(left=5, error="kokoro-onnx isn't installed")
    problems = pipeline_problems(llm, youtube, mb, intros)
    assert [(p.kind, p.cause) for p in problems] == [
        ("llm", "daily quota"),
        ("ytmusic", "stopped"),
        ("voice", "kokoro-onnx isn't installed"),
        ("musicbrainz", "unavailable"),
    ]
    fine = ArtistLookup(tmp_path / "yt.json"), MusicBrainz(Cache(tmp_path / "c.sqlite"))
    assert pipeline_problems(None, *fine, Intros()) == []
