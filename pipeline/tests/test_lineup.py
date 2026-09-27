from giggle_pipeline.cache import Cache, key_for
from giggle_pipeline.lineup import (
    BATCH,
    PROMPT_VERSION,
    batched_by_venue,
    checked,
    excerpt,
    grounded,
    listing,
    mentions,
    not_playing,
    parse_lineups,
    tidy,
)
from giggle_pipeline.llm import FakeLLM, LLMError

GIGS = [
    {
        "id": "occii:1",
        "title": "KRONKEL FESTIVAL",
        "description": "LINE-UP: Deli Girls // synth punk",
    },
    {"id": "nobel:2", "title": "Discover: Ronker + Grote Geelstaart"},
]


def model(answers):
    """A fake model answering with fixed rows, counting calls."""
    return FakeLLM(lambda task, user: {"listings": answers})


def test_names_must_appear_in_the_listing():
    item = {"title": "KRONKEL FESTIVAL", "description": "LINE-UP: Deli Girls // synth punk"}
    assert grounded(["Deli Girls", "Made Up Band", "deli girls"], item) == ["Deli Girls"]


def test_the_model_cannot_add_words_in_other_scripts_or_symbols():
    item = {"title": "Foo Fighters live", "description": "Mélanie De Biasio, СОЮЗ (SOYUZ)"}
    injected = [
        "Foo Привет, подпишитесь Fighters",  # ASCII folding alone dropped the Cyrillic
        "Foo 🔥 Fighters",
        "Foo‮ Fighters",  # a bidi override: dropped, what's left is fine
        "Foo\nFighters",
    ]
    assert grounded(injected, item) == ["Foo Fighters"]
    assert grounded(["Melanie De Biasio", "Mélanie De Biasio!"], item) == ["Melanie De Biasio"]
    assert grounded(["СОЮЗ (SOYUZ)", "СОЮЗ"], item) == ["СОЮЗ (SOYUZ)"]  # "СОЮЗ" folds to ""


def test_batches_hold_one_venue_each_in_the_order_asked():
    ids = ["a:1", "b:1", "a:2", "c:1", "a:3"]
    venue = {gid: gid.split(":")[0] for gid in ids}
    assert batched_by_venue(ids, venue) == [["a:1", "a:2", "a:3"], ["b:1"], ["c:1"]]
    many = [f"a:{i}" for i in range(BATCH + 1)]
    assert [len(b) for b in batched_by_venue(many, dict.fromkeys(many, "a"))] == [BATCH, 1]


def test_model_answers_are_used_grounded_and_cached(tmp_path):
    cache = Cache(tmp_path / "c.sqlite")
    llm = model([
        {"id": "occii:1", "kind": "festival", "headliners": [], "support": ["Deli Girls", "Ghost"]},
        {"id": "nobel:2", "kind": "concert", "headliners": ["Ronker", "Grote Geelstaart"],
         "support": []},
    ])  # fmt: skip
    first = parse_lineups(GIGS, llm, cache)
    assert first["occii:1"]["kind"] == "festival"
    assert first["occii:1"]["support"] == ["Deli Girls"]  # "Ghost" isn't in the listing
    assert first["nobel:2"]["headliners"] == ["Ronker", "Grote Geelstaart"]

    again = parse_lineups(GIGS, llm, cache)
    assert again == first
    assert llm.calls == 1, "the second run is served from the cache"


def test_failures_fall_back_to_rules_and_are_retried_next_time(tmp_path):
    cache = Cache(tmp_path / "c.sqlite")

    def broken(task, user):
        raise LLMError("JSON Mode couldn't be met")

    llm = FakeLLM(broken)
    result = parse_lineups(GIGS, llm, cache)
    assert result["nobel:2"] == {
        "kind": "concert",
        "headliners": ["Ronker", "Grote Geelstaart"],
        "support": [],
        "source": "rules",
    }
    parse_lineups(GIGS, llm, cache)
    assert llm.calls == 2, "rule fallbacks aren't cached"


def test_call_budget_limits_requests(tmp_path):
    gigs = [{"id": f"x:{i}", "title": f"Band {i}"} for i in range(30)]
    llm = FakeLLM(lambda task, user: {"listings": []}, task_max_calls={"lineup": 1})
    result = parse_lineups(gigs, llm, Cache(tmp_path / "c.sqlite"))
    assert llm.calls == 1
    assert len(result) == 30 and all(r["source"] == "rules" for r in result.values())


# --- the three known v2 errors, with listings and model answers from a live run ------

BRASS_RAVE = {
    "id": "bimhuis:150881",
    "title": "Brass Rave Unit | MANOLO",
    "categories": ["Amsterdam Dance Event"],
    "description": "Clubavond met rave-act uit de Amsterdamse underground die alles "
    "letterlijk omverblaast.",
}
PARKHOF = {
    "id": "occii:103314",
    "title": "PARKHOF NIGHT w/ WANDA'S + THE BATTLE OF PARKHOF (BOOK) + IS THERE MORE "
    "THAN THE STREET (FILM) + GW SOK (q/a)",
    "categories": ["music"],
    "description": "Parkhof night at OCCII:: a film, a book, a band film: Is er meer dan de "
    "straat (20 min.) book: De slag om Parkhof (160 pag.) band: Wanda's (dr gtr gtr bs v)",
}
KRONKEL = {
    "id": "occii:102229",
    "title": "KRONKEL FESTIVAL",
    "categories": ["music"],
    "description": "GEREGELD ONTREGELD, PRETTY UGLY & BANDGURL666 PRESENT: KRONKEL - An "
    "alternative, multi-venue, one day festival in Amsterdam celebrating the underground! "
    + "Meander through Amsterdam town and satiate your hunger for the unconventional. "
    * 8
    + "Geregeld Ontregeld, Pretty Ugly & Bandgurl666 team up to present to you a programme "
    "inspired by DIY culture. LINE-UP: Adam b2b Steve // hyperpop, gabber // NL Deli Girls "
    "// synth punk, digital hardcore // NYC, USA Books // alt rock, no wave // NL",
}


def test_a_band_playing_dance_music_is_a_concert(tmp_path):
    # Up to the prompt (v2 said "club"); the answer is used as the model gives it.
    llm = model([{"id": BRASS_RAVE["id"], "kind": "concert", "headliners": ["Brass Rave Unit"],
                  "support": ["MANOLO"]}])  # fmt: skip
    result = parse_lineups([BRASS_RAVE], llm, Cache(tmp_path / "c.sqlite"))
    assert result[BRASS_RAVE["id"]] == {
        "kind": "concert",
        "headliners": ["Brass Rave Unit"],
        "support": ["MANOLO"],
        "source": "fake",
    }


def test_a_music_night_with_a_book_and_a_film_is_a_concert(tmp_path):
    # What the model said (v2 and v3 alike): not music, with the book and the Q&A as acts.
    llm = model([{"id": PARKHOF["id"], "kind": "not_music",
                  "headliners": ["Wanda's", "The Battle of Parkhof", "GW SOK"],
                  "support": []}])  # fmt: skip
    result = parse_lineups([PARKHOF], llm, Cache(tmp_path / "c.sqlite"))
    assert result[PARKHOF["id"]]["kind"] == "concert", "the listing says Wanda's is the band"
    assert result[PARKHOF["id"]]["headliners"] == ["Wanda's"]


def test_presenters_are_not_performers(tmp_path):
    seen = []

    def answer(task, user):
        seen.append(user)
        return {"listings": [{"id": KRONKEL["id"], "kind": "festival",
                              "headliners": ["KRONKEL FESTIVAL"],
                              "support": ["GEREGELD ONTREGELD", "PRETTY UGLY", "BANDGURL666",
                                          "Adam b2b Steve", "Deli Girls", "Books"]}]}  # fmt: skip

    result = parse_lineups([KRONKEL], FakeLLM(answer), Cache(tmp_path / "c.sqlite"))
    assert "Deli Girls" in seen[0], "the model sees the line-up, far down the description"
    assert result[KRONKEL["id"]]["headliners"] == []
    assert result[KRONKEL["id"]]["support"] == ["Adam b2b Steve", "Deli Girls", "Books"]


# --- the checks ---------------------------------------------------------------------


def test_presenter_positions():
    kronkel = [KRONKEL["title"], KRONKEL["description"]]
    for name in ["Geregeld Ontregeld", "Pretty Ugly", "Bandgurl666"]:
        assert not_playing(name, kronkel), name
    assert not not_playing("Deli Girls", kronkel)
    assert not_playing("Leidse Geluiden", ["Leidse Geluiden presenteert: Nobel Sessions"])
    assert not_playing("Pretty Ugly", ["Pretty//Ugly presents a night of queer folk"])
    assert not_playing("Le Guess Who? & U?", ["LE GUESS WHO? & U? PRESENT: TOTALLY WIRED"])
    assert not_playing("Birds of Paradise", ["Birds of Paradise presents"])
    assert not_playing("Subbacultcha", ["A night presented by BIMHUIS & Subbacultcha."])
    # Presenting an album is playing it; so is any other mention.
    assert not not_playing("Moss", ["Moss presenteert nieuw album"])
    assert not not_playing("Orgel Vreten", ["Orgel Vreten presenteert hun nieuwe vinyl-ep"])
    assert not not_playing("Joel Ross", ["Joel Ross presents his latest Blue Note album"])
    five_dollar_shake = [
        "Five Dollar Shake presents: 21st Century Blues",
        "Op 20 december cureert de Utrechtse band Five Dollar Shake een festival",
    ]
    assert not not_playing("Five Dollar Shake", five_dollar_shake)
    assert not not_playing("Nowhere", five_dollar_shake), "not mentioned: not a presenter"


def test_books_films_and_talks_beside_the_music():
    title = ["MUSIC & TALK WITH Eric Isaacson + BHAJAN BHOY (Solo Set)"]
    assert mentions("Eric Isaacson", title) == ["aside"]
    assert mentions("Bhajan Bhoy", title) == ["plays"]
    assert mentions("Wanda's", [PARKHOF["title"], PARKHOF["description"]]) == ["", "plays"]
    assert not_playing("GW Sok", [PARKHOF["title"]])
    assert not_playing("Is there more than the street", [PARKHOF["title"]])
    # A talk with no one marked as playing stays a talk.
    talk = {"id": "x:1", "title": "Lezing: Henk de Vries", "description": "Over de jaren 80."}
    row = {"kind": "not_music", "headliners": ["Henk de Vries"], "support": []}
    assert checked(row, talk)["kind"] == "not_music"


def test_names_are_tidied_and_event_names_and_filler_dropped():
    assert tidy("MINDWAR (BE)") == "MINDWAR"
    assert tidy("Colin Newman (Wire)") == "Colin Newman"
    assert tidy("Blanks • Haarlem Vinyl Festival") == "Blanks"
    assert tidy("СОЮЗ (SOYUZ)") == "СОЮЗ (SOYUZ)", "nothing left to match without the note"
    item = {
        "id": "x:1",
        "title": "Popronde 2026: Blanks • Haarlem Vinyl Festival + Yurt Sessions + support",
        "description": "MINDWAR (BE) plays with special guests",
    }
    row = {
        "kind": "festival",
        "headliners": ["Popronde 2026", "Blanks • Haarlem Vinyl Festival"],
        "support": ["Yurt Sessions", "support", "special guests", "MINDWAR (BE)", "Blanks"],
    }
    assert checked(row, item) == {
        "kind": "festival",
        "headliners": ["Blanks"],
        "support": ["MINDWAR"],
    }


def test_genres_and_venue_labels_are_not_names():
    item = listing({
        "id": "paradiso:2865483",
        "title": "Sophie Straat's Protestfest 5",
        "genres": ["Alternative / Indie / Rock", "Live after Lowlands"],
        "categories": ["Concert", "& Subbacultcha"],
    })  # fmt: skip
    names = ["Sophie Straat", "Alternative / Indie / Rock", "Live after Lowlands", "Subbacultcha"]
    assert grounded(names, item) == ["Sophie Straat"]


def test_a_line_up_further_down_the_description_is_kept():
    assert excerpt("short") == "short"
    about = "A festival about things. " * 40
    assert excerpt(about + "LINE-UP: Deli Girls").endswith("… LINE-UP: Deli Girls")
    assert excerpt(about + "The lineup includes BeaBop").endswith("… lineup includes BeaBop")
    assert len(excerpt(about + "a line-up connecting shades of punk")) == 600


def test_answers_meant_for_another_listing_are_not_used(tmp_path):
    cache = Cache(tmp_path / "c.sqlite")
    llm = model([
        {"id": "occii:1", "kind": "concert", "headliners": ["Ronker"], "support": []},
        {"id": "nobel:2", "kind": "concert", "headliners": ["Ronker"], "support": []},
    ])  # fmt: skip
    result = parse_lineups(GIGS, llm, cache)
    assert result["occii:1"]["source"] == "rules", "no Ronker in the KRONKEL listing"
    assert result["nobel:2"]["source"] == "fake"
    parse_lineups(GIGS, llm, cache)
    assert llm.calls == 2, "the misplaced answer isn't cached, so it's asked again"


def test_cached_answers_are_checked_on_every_run(tmp_path):
    cache = Cache(tmp_path / "c.sqlite")
    raw = {"kind": "festival", "headliners": [], "support": ["PRETTY UGLY", "Deli Girls"]}
    cache.put("lineup", key_for(PROMPT_VERSION, "fake", listing(KRONKEL)), raw)
    result = parse_lineups([KRONKEL], model([]), cache)
    assert result[KRONKEL["id"]]["support"] == ["Deli Girls"]
