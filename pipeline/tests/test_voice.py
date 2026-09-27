import numpy as np
import pytest

from giggle_pipeline.voice import (
    PEAK_CEILING_DBFS,
    TARGET_RMS_DBFS,
    Entry,
    Lexicon,
    Voice,
    encode_mp3,
    normalise,
    splice_phonemes,
)

RATE = 24_000

LEXICON = Lexicon(
    [
        Entry("Paradiso", "pˌaɹədˈiːzəʊ"),
        Entry("Bimhuis", "bˈɪmhaʊs"),
        Entry("Patronaat", "pˌatɹəʊnˈɑːt"),
        Entry("Muziekgebouw aan 't IJ", "muːzˈiːkhəbˌaʊ ɑːn ət ˈaɪ"),
        Entry("IJ", "ˈaɪ", match_case=True),
    ]
)


def sine(seconds=1.0, amplitude=0.5, freq=220.0):
    t = np.arange(int(RATE * seconds)) / RATE
    return (amplitude * np.sin(2 * np.pi * freq * t)).astype(np.float32)


class FakeSynth:
    name = "fake-tts"
    sample_rate = RATE

    def __init__(self):
        self.calls = []

    def synthesize(self, text, voice, speed):
        self.calls.append((text, voice, speed))
        return sine(0.5)


def voice(**kw):
    kw.setdefault("lexicon", LEXICON)
    kw.setdefault("synthesizer", FakeSynth())
    return Voice(**kw)


# --- lexicon ---------------------------------------------------------------------


def test_lexicon_marks_up_names_and_reports_entries_used():
    text, used = LEXICON.apply("Tonight at Paradiso, then the Bimhuis.")
    assert text == "Tonight at [Paradiso](/pˌaɹədˈiːzəʊ/), then the [Bimhuis](/bˈɪmhaʊs/)."
    assert used == {"Bimhuis": "bˈɪmhaʊs", "Paradiso": "pˌaɹədˈiːzəʊ"}


def test_lexicon_matches_whole_words_only():
    text, used = LEXICON.apply("Paradisos and Bimhuisje and ParadisoX stay as they are")
    assert used == {}
    assert "[" not in text


def test_lexicon_ignores_case_unless_told_not_to():
    text, used = LEXICON.apply("PARADISO and paradiso; the IJ, not the ij")
    assert text.count("(/pˌaɹədˈiːzəʊ/)") == 2
    assert "[PARADISO]" in text and "[paradiso]" in text
    assert "[IJ](/ˈaɪ/)" in text and "the ij" in text


@pytest.mark.parametrize(
    ("written", "spoken"),
    [
        ("Paradiso's", "[Paradiso's](/pˌaɹədˈiːzəʊz/)"),  # vowel: z
        ("Patronaat's", "[Patronaat's](/pˌatɹəʊnˈɑːts/)"),  # voiceless: s
        ("Bimhuis's", "[Bimhuis's](/bˈɪmhaʊsɪz/)"),  # sibilant: ɪz
        ("Paradiso’s", "[Paradiso's](/pˌaɹədˈiːzəʊz/)"),  # typographic apostrophe
    ],
)
def test_lexicon_handles_possessives(written, spoken):
    text, used = LEXICON.apply(f"{written} stage")
    assert text == f"{spoken} stage"
    assert len(used) == 1


def test_lexicon_prefers_the_longest_name():
    text, used = LEXICON.apply("At the Muziekgebouw aan ’t  IJ tonight")
    assert text == "At the [Muziekgebouw aan 't  IJ](/muːzˈiːkhəbˌaʊ ɑːn ət ˈaɪ/) tonight"
    assert list(used) == ["Muziekgebouw aan 't IJ"]


def test_default_lexicon_loads():
    lexicon = Lexicon.load()
    text, used = lexicon.apply("Tolhuistuin, OCCII and the Melkweg")
    assert set(used) == {"Tolhuistuin", "OCCII", "Melkweg"}
    assert all(ipa and "/" not in ipa for ipa in (e.ipa for e in lexicon.entries))


def test_splice_phonemes_keeps_spacing_and_punctuation():
    def phonemize(text):
        return text.strip().upper()

    spliced = splice_phonemes("at [Paradiso](/pa/), then [OCCII](/ok/). Bye", phonemize)
    assert spliced == "AT pa, THEN ok. BYE"
    assert splice_phonemes("[A](/a/) [B](/b/)", phonemize) == "a b"


# --- clip names ------------------------------------------------------------------


def test_hash_is_stable():
    text = "You're listening to Glass Harbour, at Paradiso."
    assert voice().clip_hash(text) == voice().clip_hash(text)
    # If this changes, every clip is re-rendered and re-uploaded: only ever on purpose.
    assert voice().clip_hash(text) == "939264aebf1fcf04bcb0"


def test_the_real_models_name_is_pinned():
    # Part of every clip's hash, like RENDER_VERSION: renaming it re-renders every clip.
    assert Voice(lexicon=LEXICON).synthesizer.name == "kokoro-v1.0-fp32/en-gb"


def test_hash_ignores_whitespace_differences():
    assert voice().clip_hash("at  Paradiso\n tonight") == voice().clip_hash("at Paradiso tonight")


def test_hash_changes_with_everything_that_changes_the_sound():
    text = "Glass Harbour play Paradiso."
    base = voice().clip_hash(text)
    assert voice().clip_hash(text + "!") != base
    assert voice(voice="bm_george").clip_hash(text) != base
    assert voice(speed=1.1).clip_hash(text) != base
    other_model = FakeSynth()
    other_model.name = "other-tts"
    assert voice(synthesizer=other_model).clip_hash(text) != base


def test_hash_changes_only_when_a_used_lexicon_entry_changes():
    text = "Glass Harbour play Paradiso."
    base = voice().clip_hash(text)
    edited = Lexicon(
        [
            Entry("Paradiso", "pˌaɹədˈiːsəʊ") if e.written == "Paradiso" else e
            for e in LEXICON.entries
        ]
    )
    assert voice(lexicon=edited).clip_hash(text) != base
    unrelated = Lexicon(
        [
            *(
                Entry("Bimhuis", "bˈɪmhœys") if e.written == "Bimhuis" else e
                for e in LEXICON.entries
            ),
            Entry("Cinetol", "sˈiːnətˌɒl"),
        ]
    )
    assert voice(lexicon=unrelated).clip_hash(text) == base


# --- rendering -------------------------------------------------------------------


def test_render_synthesizes_once_then_reuses_the_clip(tmp_path):
    synth = FakeSynth()
    v = voice(synthesizer=synth, voice="bf_isabella", speed=0.9)
    first = v.render("Next up at Paradiso.", tmp_path)
    second = v.render("Next up at Paradiso.", tmp_path)
    assert first == second == tmp_path / f"{v.clip_hash('Next up at Paradiso.')}.mp3"
    assert synth.calls == [("Next up at [Paradiso](/pˌaɹədˈiːzəʊ/).", "bf_isabella", 0.9)]
    assert (v.rendered, v.reused) == (1, 1)
    assert list(tmp_path.iterdir()) == [first]


def test_existing_clip_never_loads_the_model(tmp_path):
    v = Voice(model_dir=tmp_path / "no-models-here", lexicon=LEXICON)
    path = v.path_for("Hello", tmp_path)
    path.write_bytes(b"already rendered")
    assert v.render("Hello", tmp_path) == path
    assert v.synthesizer._tts is None
    assert not (tmp_path / "no-models-here").exists()


def test_render_writes_an_mp3(tmp_path):
    path = voice().render("Hello", tmp_path)
    frames, rate = mp3_frames(path.read_bytes())
    assert rate == RATE
    assert abs(frames * 576 / RATE - 0.7) < 0.1  # 0.5 s of audio plus 0.1 s padding each side


# --- audio -----------------------------------------------------------------------


def test_encode_mp3_produces_mono_mpeg2_layer3_frames():
    data = encode_mp3(sine(2.0), RATE)
    frames, rate = mp3_frames(data)
    assert rate == RATE
    assert abs(frames * 576 / RATE - 2.2) < 0.1
    assert data[3] >> 6 == 0b11  # channel mode: mono


def db(x):
    return 20 * np.log10(x)


def test_normalise_brings_quiet_and_loud_speech_to_the_same_level():
    for amplitude in (0.02, 0.9):
        audio = np.concatenate([sine(1.0, amplitude), np.zeros(RATE, np.float32)])
        out = normalise(audio, RATE)
        voiced = out[: RATE // 2]
        assert db(np.sqrt(np.mean(voiced**2))) == pytest.approx(TARGET_RMS_DBFS, abs=0.5)
        assert db(np.abs(out).max()) <= PEAK_CEILING_DBFS + 0.01


def test_normalise_limits_peaks_and_leaves_silence_alone():
    spiky = sine(1.0, 0.01)
    spiky[RATE // 2] = 1.0
    assert db(np.abs(normalise(spiky, RATE)).max()) == pytest.approx(PEAK_CEILING_DBFS, abs=0.01)
    silence = np.zeros(RATE, np.float32)
    assert not normalise(silence, RATE).any()


# MPEG audio frame headers: https://www.mp3-tech.org/programmer/frame_header.html
_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
_RATES_V2 = [22050, 24000, 16000]


def mp3_frames(data: bytes) -> tuple[int, int]:
    """Walks MPEG-2 Layer III frames from the start of the data; (frame count, sample rate)."""
    pos = count = 0
    rate = None
    while pos + 4 <= len(data):
        b1, b2 = data[pos + 1], data[pos + 2]
        assert data[pos] == 0xFF and b1 & 0xE0 == 0xE0, f"no frame sync at byte {pos}"
        assert (b1 >> 3) & 0b11 == 0b10, "not MPEG-2"
        assert (b1 >> 1) & 0b11 == 0b01, "not Layer III"
        bitrate = _BITRATES_V2_L3[b2 >> 4] * 1000
        rate = _RATES_V2[(b2 >> 2) & 0b11]
        padding = (b2 >> 1) & 1
        pos += 72 * bitrate // rate + padding
        count += 1
    assert pos == len(data) and count
    return count, rate


def test_each_artist_keeps_one_announcer_and_both_are_used():
    from giggle_pipeline.voice import ANNOUNCERS, announcer_for

    keys = [f"mb:{i:04d}" for i in range(200)]
    assert {announcer_for(k) for k in keys} == set(ANNOUNCERS)
    assert announcer_for("mb:b017a7ae") == announcer_for("mb:b017a7ae")
