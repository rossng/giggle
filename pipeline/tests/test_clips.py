import json
from datetime import date, timedelta

import numpy as np

from giggle_pipeline.clips import (
    KEEP_DAYS,
    MANIFEST,
    PREVIOUS_WORDINGS,
    clip_text,
    render_intros,
)
from giggle_pipeline.voice import (
    ANNOUNCERS,
    Lexicon,
    Voice,
    VoiceError,
    announcer_for,
    encode_mp3,
    mp3_seconds,
)

RATE = 24_000


class FakeSynth:
    name = "fake-tts"
    sample_rate = RATE

    def __init__(self, seconds=0.5):
        self.seconds = seconds
        self.calls = []

    def synthesize(self, text, voice, speed):
        self.calls.append((text, voice))
        t = np.arange(int(RATE * self.seconds)) / RATE
        return (0.5 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


class BrokenSynth(FakeSynth):
    def synthesize(self, text, voice, speed):
        raise VoiceError("kokoro-onnx isn't installed")


ARTISTS = {f"k{i}": {"name": f"Band {i}"} for i in range(4)}
BLURBS = {
    "k0": ["a Glasgow band", "a shoegaze band"],
    "k1": ["a Lisbon singer"],
    "k2": [],
    "k3": ["a Norwegian rock band", "a Bergen band", "a band singing in Norwegian"],
}
ORDER = ["k3", "k0", "k1", "k2"]


TODAY = date(2026, 9, 27)


def run(tmp_path, today=TODAY, blurbs=BLURBS, order=ORDER, **kw):
    kw.setdefault("synthesizer", FakeSynth())
    kw.setdefault("lexicon", Lexicon([]))
    return render_intros(ARTISTS, blurbs, order, tmp_path / "cache", tmp_path / "site", today, **kw)


def render(tmp_path, **kw):
    return run(tmp_path, **kw).clips


def names(directory):
    return sorted(p.name for p in directory.glob("*.mp3"))


def test_clip_text():
    assert (
        clip_text("Mogwai", "a Glasgow post-rock band.")
        == "Next up, Mogwai, a Glasgow post-rock band."
    )


def test_renders_every_variant_in_the_artists_voice(tmp_path):
    synth = FakeSynth()
    result = render(tmp_path, synthesizer=synth)
    assert list(result) == ["k3", "k0", "k1"]  # no blurbs, no clips
    assert [c["text"] for c in result["k0"]] == [
        "Next up, Band 0, a Glasgow band.",
        "Next up, Band 0, a shoegaze band.",
    ]
    for key, clips in result.items():
        for clip in clips:
            assert clip["voice"] == announcer_for(key) in ANNOUNCERS
            assert clip["file"].startswith("voice/") and clip["file"].endswith(".mp3")
            assert (tmp_path / "site" / clip["file"]).exists()
            assert clip["seconds"] > 0.5
    assert len(synth.calls) == 6


def test_existing_clips_are_never_rendered_again(tmp_path):
    first = render(tmp_path)
    synth = FakeSynth()
    assert render(tmp_path, synthesizer=synth) == first
    assert synth.calls == []


def test_budget_goes_breadth_first_soonest_first(tmp_path):
    synth = FakeSynth()
    result = render(tmp_path, synthesizer=synth, max_renders=4)
    # First variants for k3, k0, k1, then k3's second.
    assert [t for t, _ in synth.calls] == [
        "Next up, Band 3, a Norwegian rock band.",
        "Next up, Band 0, a Glasgow band.",
        "Next up, Band 1, a Lisbon singer.",
        "Next up, Band 3, a Bergen band.",
    ]
    assert {k: len(v) for k, v in result.items()} == {"k3": 2, "k0": 1, "k1": 1}
    # The next night picks up where this one stopped, and reuse costs nothing.
    synth = FakeSynth()
    result = render(tmp_path, synthesizer=synth, max_renders=4)
    assert len(synth.calls) == 2
    assert [c["text"] for c in result["k3"]][-1] == "Next up, Band 3, a band singing in Norwegian."


def test_without_the_model_existing_clips_are_still_used(tmp_path):
    render(tmp_path, max_renders=1)
    intros = run(tmp_path, synthesizer=BrokenSynth())
    assert {k: len(v) for k, v in intros.clips.items()} == {"k3": 1}
    assert intros.error == "kokoro-onnx isn't installed"
    assert (intros.rendered, intros.left) == (0, 5)


def test_rendering_stops_at_the_time_limit(tmp_path):
    ticks = iter(range(100))
    intros = run(tmp_path, clock=lambda: next(ticks) * 60.0, max_seconds=150)
    # Starts at 0; checks at 60 s and 120 s render, the one at 180 s stops.
    assert (intros.rendered, intros.left, intros.error) == (2, 4, None)


def test_clips_live_in_the_cache_and_the_site_gets_only_the_ones_used(tmp_path):
    first = render(tmp_path)
    cached = names(tmp_path / "cache")
    assert names(tmp_path / "site" / "voice") == cached and len(cached) == 6
    shorter = {"k0": ["a Glasgow band"]}
    run(tmp_path, blurbs=shorter, order=["k0"])
    assert names(tmp_path / "site" / "voice") == [first["k0"][0]["file"].removeprefix("voice/")]
    assert names(tmp_path / "cache") == cached, "unused clips stay cached for a while"


def test_clips_already_in_the_site_join_the_cache(tmp_path):
    render(tmp_path)
    for path in (tmp_path / "cache").glob("*.mp3"):
        path.unlink()
    (tmp_path / "site" / "voice" / "0123456789abcdef0123.mp3").write_bytes(b"old")
    synth = FakeSynth()
    render(tmp_path, synthesizer=synth)
    assert synth.calls == [], "every clip came from the site"
    assert len(names(tmp_path / "cache")) == 7
    assert len(names(tmp_path / "site" / "voice")) == 6


def test_clips_unused_for_a_while_are_deleted(tmp_path):
    render(tmp_path)
    manifest = json.loads((tmp_path / "cache" / MANIFEST).read_text())
    assert set(manifest.values()) == {TODAY.isoformat()}
    nobody = {k: [] for k in BLURBS}
    later = TODAY + timedelta(days=KEEP_DAYS)
    render_intros(ARTISTS, nobody, ORDER, tmp_path / "cache", tmp_path / "site", later)
    assert len(names(tmp_path / "cache")) == 6
    render_intros(
        ARTISTS, nobody, ORDER, tmp_path / "cache", tmp_path / "site", later + timedelta(1)
    )
    assert names(tmp_path / "cache") == []
    assert json.loads((tmp_path / "cache" / MANIFEST).read_text()) == {}


def test_clips_in_an_earlier_wording_stand_in_until_rerendered(tmp_path):
    old = PREVIOUS_WORDINGS[0]
    cache = tmp_path / "cache"
    synth = FakeSynth()
    for key in ("k0", "k1"):
        voice = Voice(voice=announcer_for(key), lexicon=Lexicon([]), synthesizer=synth)
        voice.render(old(ARTISTS[key]["name"], BLURBS[key][0]), cache)
    result = render(tmp_path, max_renders=2)
    # k3's and k0's first variants are rendered anew; k1's stays in the old wording.
    assert [c["text"] for c in result["k0"]] == ["Next up, Band 0, a Glasgow band."]
    assert [c["text"] for c in result["k1"]] == ["Band 1, a Lisbon singer."]
    assert "k3" in result and len(result["k3"]) == 1


def test_clip_names_match_the_voice_module(tmp_path):
    synth = FakeSynth()
    result = render(tmp_path, synthesizer=synth)
    voice = Voice(voice=announcer_for("k1"), lexicon=Lexicon([]), synthesizer=synth)
    assert (
        result["k1"][0]["file"]
        == f"voice/{voice.path_for('Next up, Band 1, a Lisbon singer.', tmp_path / 'cache').name}"
    )


def test_mp3_seconds_is_the_played_length(tmp_path):
    # 1 s of audio + 2 × 100 ms pads, plus the encoder's lead-in and last partial frame.
    path = tmp_path / "a.mp3"
    path.write_bytes(encode_mp3(np.zeros(RATE, dtype=np.float32) + 0.1, RATE))
    frames = path.stat().st_size / 144
    assert frames == int(frames)
    assert mp3_seconds(path) == frames * 576 / RATE
    assert 1.2 < mp3_seconds(path) < 1.2 + 0.1
