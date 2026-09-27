import json

import pytest

from giggle_pipeline import blurbs
from giggle_pipeline.blurbs import enough, facts, problems, tidy, usable, write_blurbs
from giggle_pipeline.cache import Cache
from giggle_pipeline.llm import FakeLLM, LLMError


def artist(name="Glass Harbour", key=None, **overrides):
    record = {
        "key": key or f"name:{name.lower()}",
        "name": name,
        "match": {"mbid": "x", "name": name, "disambiguation": "Scottish shoegaze band"},
        "musicbrainz": {
            "type": "Group",
            "country": "GB",
            "area": "Scotland",
            "begin_area": "Glasgow",
            "begin": "2014-03",
            "genres": ["shoegaze", "post-punk"],
            "tags": ["seen live", "shoegaze", "scottish", "2010s"],
        },
        "lastfm": {
            "tags": ["shoegaze", "dream pop", "favorites"],
            "listeners": 12345,
            "similar": ["Slowdive", "Ride"],
            "bio": "Glass Harbour are a four-piece from Glasgow.",
        },
        "wikipedia": None,
        "top_tracks": [{"title": "Tidewater", "listeners": 10, "playcount": 20}],
        "gigs": ["paradiso:1"],
    }
    record.update(overrides)
    return record


THIN = {"key": "name:nobody", "name": "Nobody", "match": None, "musicbrainz": None,
        "lastfm": None, "wikipedia": None, "top_tracks": None, "gigs": []}  # fmt: skip


@pytest.fixture
def cache(tmp_path):
    c = Cache(tmp_path / "cache.sqlite")
    yield c
    c.close()


def answering(variants_for):
    """A FakeLLM answering each artist with variants_for(facts)."""
    seen = []

    def answer(task, user):
        assert task == "blurb"
        items = json.loads(user)
        seen.append(items)
        return {"artists": [{"id": i["id"], "variants": variants_for(i)} for i in items]}

    fake = FakeLLM(answer)
    fake.name = "test"  # not "fake": exercises the real model's cache path
    fake.seen = seen
    return fake


GOOD = [
    "a Glasgow band pouring shoegaze guitars over a post-punk rhythm section",
    "a Scottish shoegaze four-piece in the vein of Slowdive and Ride",
]

# --- facts -------------------------------------------------------------------------


def test_facts_gathers_what_the_sources_say():
    f = facts(artist())
    assert f["name"] == "Glass Harbour"
    assert f["from"] == "Glasgow, Scotland, United Kingdom"
    assert f["nationality"] == "Scottish, British"
    assert f["formed"] == "2014"
    assert f["genres"] == ["shoegaze", "post-punk", "dream pop"]  # no junk, no repeats
    assert f["similar artists"] == ["Slowdive", "Ride"]
    assert f["popular songs"] == ["Tidewater"]
    assert "gigs" not in f and "listeners" not in json.dumps(f)  # no gig details, no counts


def test_a_persons_begin_is_a_birth_date_not_a_formation():
    mb = {**artist()["musicbrainz"], "type": "Person", "begin": "1990-01-01"}
    assert "formed" not in facts(artist(musicbrainz=mb))


def test_long_texts_are_cut_at_a_sentence():
    bio = "First sentence here. " * 60
    f = facts(artist(lastfm={"bio": bio}))
    assert len(f["last.fm bio"]) <= blurbs.TEXT_CHARS
    assert f["last.fm bio"].endswith(".")


def test_thin_records_get_no_blurb_and_no_request(cache):
    llm = answering(lambda f: GOOD)
    genre_only = {**THIN, "key": "name:g", "musicbrainz": {"genres": ["jazz"]}}
    assert not enough(facts(THIN))
    assert not enough(facts(genre_only))
    assert enough(facts(artist()))
    result = write_blurbs({"name:nobody": THIN, "name:g": genre_only}, llm, cache)
    assert result == {"name:nobody": [], "name:g": []}
    assert llm.calls == 0


# --- checks ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "clean"),
    [
        ('"A Glasgow band."', "a Glasgow band"),
        ("Glass Harbour, a Glasgow band", "a Glasgow band"),
        ("is a Glasgow band", "a Glasgow band"),
        ("a Amsterdam-born singer", "an Amsterdam-born singer"),
        ("a European act", "a European act"),
        ("The band behind 'Tidewater'", "the band behind 'Tidewater'"),
        ("a band specializing in gray, colorful noise",
         "a band specialising in grey, colourful noise"),
        ("an oversized sound & a prize-winning size",
         "an oversized sound and a prize-winning size"),
    ],
)  # fmt: skip
def test_tidy(raw, clean):
    assert tidy(raw, "Glass Harbour") == clean


def test_grounded_variants_pass():
    f = facts(artist())
    for text in GOOD:
        assert problems(text, f) == [], text
    # Nationality from the country code, and years that are in the facts, are fine.
    assert problems("a British shoegaze band together since 2014 in Glasgow", f) == []


@pytest.mark.parametrize(
    ("text", "why"),
    [
        ("a Berlin band pouring shoegaze guitars over a post-punk rhythm section", "Berlin"),
        ("a shoegaze band from Glasgow, together since 2009 and still loud", "2009"),
        ("a shoegaze trio from Glasgow with a post-punk rhythm section", "trio"),
        ("a legendary shoegaze band from Glasgow with a post-punk rhythm section", "legendary"),
        ("a shoegaze band from Glasgow, back at the venue on Thursday", "thursday"),
        ("a shoegaze band from Glasgow with tickets going fast", "tickets"),
        ("Glass Harbour are a shoegaze band from Glasgow, loud and proud", "name"),
        ("a shoegaze band from Glasgow in the vein of Slowdive with the post-punk "
         "rhythm section of Ride and more guitars than you can count", "words"),
        ("a Glasgow band (shoegaze)", "symbols"),
        ("a shoegaze band from Glasgow with a soulful, haunting sound", "soulful"),
        ("a band", "short"),
    ],
)  # fmt: skip
def test_ungrounded_variants_are_rejected(text, why):
    found = problems(text, facts(artist()))
    assert any(why.lower() in p.lower() for p in found), found


@pytest.mark.parametrize(
    "text",
    [
        # Lower-case claims planted in a bio: every such word must be in the facts too.
        "a Glasgow band that stole every penny from its shoegaze fans",
        "a Glasgow band whose singer is a convicted fraud you should avoid",
        "a shoegaze band from Glasgow with a violent past",
    ],
)
def test_lower_case_claims_must_come_from_the_facts(text):
    f = facts(artist())
    assert any(p.startswith("word ") for p in problems(text, f)), text
    bio = f"Glass Harbour are a four-piece from Glasgow. {text[2:]}."
    assert problems(text, facts(artist(lastfm={"tags": ["shoegaze"], "bio": bio}))) == []


def test_forms_of_words_in_the_facts_pass():
    f = facts(artist(lastfm={"tags": ["shoegaze"], "bio": "They record with a drum machine."}))
    assert problems("a Glasgow shoegaze band recording with drum machines", f) == []


def test_blocked_artists_and_blurbs_are_left_out(cache, monkeypatch):
    artists = {"a": artist(), "b": artist("Other Band", key="name:other band")}
    monkeypatch.setattr(blurbs, "BLOCKED_ARTISTS", frozenset({"b"}))
    monkeypatch.setattr(blurbs, "BLOCKED_BLURBS", frozenset({blurbs.plain(GOOD[0])}))
    llm = answering(lambda f: GOOD)
    assert write_blurbs(artists, llm, cache) == {"a": GOOD[1:], "b": []}


def test_count_words_pass_when_the_facts_say_them():
    # The bio says "four-piece"; nothing says "trio".
    f = facts(artist())
    assert problems("a Glasgow four-piece pouring shoegaze guitars over post-punk", f) == []
    assert problems("a Glasgow trio pouring shoegaze guitars over post-punk", f)


def test_usable_tidies_dedupes_and_caps():
    f = facts(artist())
    raw = [GOOD[0], GOOD[0].upper().lower(), "a legendary band from Glasgow, full stop", *GOOD,
           "a Glasgow band pouring post-punk rhythm under shoegaze guitars", 42]  # fmt: skip
    kept = usable(raw, f)
    assert kept == [
        GOOD[0],
        GOOD[1],
        "a Glasgow band pouring post-punk rhythm under shoegaze guitars",
    ]


# --- the model ---------------------------------------------------------------------


def test_batches_in_order_within_the_budget(cache):
    artists = {f"k{i}": artist(f"Band {i}", key=f"k{i}") for i in range(20)}
    llm = answering(lambda f: GOOD)
    order = [f"k{i}" for i in reversed(range(20))]  # soonest first
    llm.max_calls = 2
    result = write_blurbs(artists, llm, cache, order=order, workers=2)
    assert llm.calls == 2
    assert set(result) == set(order[: 2 * blurbs.BATCH])
    assert all(v == GOOD for v in result.values())
    asked = sorted(item["name"] for batch in llm.seen for item in batch)
    assert asked == sorted(artists[k]["name"] for k in order[: 2 * blurbs.BATCH])


def test_answers_are_cached_and_rechecked(cache, monkeypatch):
    artists = {"a": artist()}
    llm = answering(lambda f: [*GOOD, "a shoegaze band from Glasgow with a massive following"])
    assert write_blurbs(artists, llm, cache) == {"a": GOOD}
    again = answering(lambda f: [])
    assert write_blurbs(artists, again, cache) == {"a": GOOD}
    assert again.calls == 0
    # Checks run on the cached answer every time, so tightening them needs no new request.
    monkeypatch.setattr(blurbs, "MAX_WORDS", 10)
    assert write_blurbs(artists, again, cache) == {"a": []}


def test_new_facts_mean_a_new_answer(cache):
    llm = answering(lambda f: GOOD)
    write_blurbs({"a": artist()}, llm, cache)
    changed = artist(wikipedia={"description": "Scottish band", "extract": "A band."})
    write_blurbs({"a": changed}, llm, cache)
    assert llm.calls == 2


def test_failed_or_missing_answers_are_retried_next_run(cache):
    def broken(task, user):
        raise LLMError("503")

    failing = FakeLLM(broken)
    failing.name = "test"
    assert write_blurbs({"a": artist()}, failing, cache) == {}
    silent = answering(lambda f: GOOD)
    silent.answer = lambda task, user: {"artists": []}
    assert write_blurbs({"a": artist()}, silent, cache) == {}
    assert write_blurbs({"a": artist()}, answering(lambda f: GOOD), cache) == {"a": GOOD}


def test_empty_answers_are_kept(cache):
    llm = answering(lambda f: [])
    assert write_blurbs({"a": artist()}, llm, cache) == {"a": []}
    write_blurbs({"a": artist()}, llm, cache)
    assert llm.calls == 1


def test_without_a_model_only_cached_blurbs(cache):
    assert write_blurbs({"a": artist()}, None, cache) == {}


def test_fake_answer_is_grounded(cache):
    result = write_blurbs({"a": artist()}, FakeLLM(blurbs.fake_answer), cache)
    assert result["a"] == [
        "a shoegaze and post-punk band from Glasgow",
        "a shoegaze band for anyone who likes Slowdive",
    ]
