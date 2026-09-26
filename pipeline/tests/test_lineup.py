from giggle_pipeline.cache import Cache
from giggle_pipeline.lineup import grounded, parse_lineups
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
    llm = model([])
    result = parse_lineups(gigs, llm, Cache(tmp_path / "c.sqlite"), max_calls=1)
    assert llm.calls == 1
    assert len(result) == 30 and all(r["source"] == "rules" for r in result.values())
