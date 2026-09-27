import contextlib
import json

import httpx
import pytest

from giggle_pipeline import blurbs, llm
from giggle_pipeline.cache import Cache
from giggle_pipeline.lineup import parse_lineups
from giggle_pipeline.llm import (
    BudgetSpent,
    FakeLLM,
    LLMError,
    QuotaExhausted,
    WorkersAI,
    cached_answer,
    store_answer,
)

SCHEMA = {"type": "object", "properties": {"x": {"type": "array"}}, "required": ["x"]}
QUOTA = {
    "errors": [
        {
            "message": "you have used up your daily free allocation of 10,000 neurons",
            "code": 4006,
        }
    ],
    "success": False,
}


class Server:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.bodies = []

    def __call__(self, request):
        self.bodies.append(json.loads(request.content))
        status, body = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        return httpx.Response(status, json=body)


def workers(server, **kw):
    http = httpx.Client(transport=httpx.MockTransport(server))
    return WorkersAI("acct", "token", http=http, sleep=lambda s: None, **kw)


def ok(value):
    return 200, {"result": {"response": value}}


def test_requests_share_one_budget_and_line_ups_leave_blurbs_a_reserve():
    model = FakeLLM(lambda task, user: {"x": []}, max_calls=5, task_max_calls={"lineup": 3})
    assert (model.remaining("lineup"), model.remaining("blurb")) == (3, 5)
    for _ in range(3):
        model.json("lineup", "", "", SCHEMA)
    with pytest.raises(BudgetSpent):
        model.json("lineup", "", "", SCHEMA)
    assert (model.remaining("lineup"), model.remaining("blurb")) == (0, 2)
    model.json("blurb", "", "", SCHEMA)
    model.json("blurb", "", "", SCHEMA)
    with pytest.raises(BudgetSpent):
        model.json("blurb", "", "", SCHEMA)
    assert model.calls == 5
    assert model.problem() is None, "a spent budget is normal, not a failure"


def test_retries_count_against_the_budget():
    server = Server((503, {"errors": []}), ok({"x": [1]}))
    model = workers(server, max_calls=10)
    assert model.json("lineup", "", "", SCHEMA) == {"x": [1]}
    assert model.calls == 2


def test_a_spent_daily_quota_stops_the_nights_llm_work_at_once():
    server = Server((429, QUOTA))
    model = workers(server, max_calls=200)
    with pytest.raises(QuotaExhausted):
        model.json("lineup", "", "", SCHEMA)
    assert len(server.bodies) == 1, "no retries"
    with pytest.raises(QuotaExhausted):
        model.json("blurb", "", "", SCHEMA)
    assert len(server.bodies) == 1, "no more requests"
    assert model.remaining("blurb") == 0
    assert "daily Workers AI allowance ran out" in model.problem()


def test_quota_skips_the_rest_of_line_ups_and_blurbs(tmp_path):
    server = Server((429, QUOTA))
    model = workers(server, max_calls=200)
    cache = Cache(tmp_path / "c.sqlite")
    gigs = [{"id": f"x:{i}", "title": f"Band {i}"} for i in range(50)]
    result = parse_lineups(gigs, model, cache)
    assert all(r["source"] == "rules" for r in result.values())
    artist = {"name": "Glass Harbour", "musicbrainz": {"genres": ["shoegaze", "post-punk"]},
              "wikipedia": {"extract": "A band."}}  # fmt: skip
    assert blurbs.write_blurbs({"a": artist}, model, cache) == {}
    assert len(server.bodies) == 1


def test_failing_requests_are_a_problem_when_many_fail():
    answers = iter([LLMError("503")] * 3 + [{"x": []}] * 7)

    def answer(task, user):
        value = next(answers)
        if isinstance(value, Exception):
            raise value
        return value

    model = FakeLLM(answer)
    for _ in range(10):
        with contextlib.suppress(LLMError):
            model.json("blurb", "", "", SCHEMA)
    assert model.problem() == "3 of 10 blurb requests failed."
    one_off = FakeLLM(lambda task, user: {"x": []})
    one_off.failed["blurb"], one_off.asked["blurb"] = 1, 2
    assert one_off.problem() is None


def test_answers_must_have_the_schemas_shape():
    model = FakeLLM(lambda task, user: {"y": 1})
    with pytest.raises(LLMError, match="lacks 'x'"):
        model.json("lineup", "", "", SCHEMA)
    model.answer = lambda task, user: {"x": "not a list"}
    with pytest.raises(LLMError):
        model.json("lineup", "", "", SCHEMA)
    assert model.failed["lineup"] == 2


def test_no_think_is_asked_for_once():
    server = Server(ok({"x": []}))
    model = workers(server)
    model.json("blurb", "system", "user", SCHEMA)
    messages = server.bodies[0]["messages"]
    text = messages[0]["content"] + messages[1]["content"]
    assert text.count("/no_think") == 1


def test_a_new_model_keeps_its_predecessors_answers(tmp_path, monkeypatch):
    cache = Cache(tmp_path / "c.sqlite")
    real = FakeLLM(lambda task, user: None)
    real.name = "test"  # a real model's cache path
    store_answer(cache, "lineup", real, 3, {"id": "a"}, {"kind": "concert"})
    monkeypatch.setitem(llm.MODELS, "lineup", "@cf/new/model")
    assert cached_answer(cache, "lineup", real, 3, {"id": "a"}) is None
    monkeypatch.setitem(llm.PREVIOUS_MODELS, "lineup", (llm.QWEN3,))
    assert cached_answer(cache, "lineup", real, 3, {"id": "a"}) == ({"kind": "concert"}, llm.QWEN3)
    # The fake model's answers never stand in for a real one's, nor the other way round.
    assert cached_answer(cache, "lineup", FakeLLM(lambda t, u: None), 3, {"id": "a"}) is None


def test_errors_quoting_an_answer_stay_on_one_line():
    # A line of the build's log starting with "::" would be a workflow command.
    with pytest.raises(LLMError) as caught:
        llm._parse({"response": "nope\n::error::fake annotation\r\n::add-mask::x"})
    assert "\n" not in str(caught.value) and "\r" not in str(caught.value)
