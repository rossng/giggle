from giggle_pipeline.collect import VenueResult
from giggle_pipeline.health import PipelineProblem, Problem, assess, updated_history, warnings
from giggle_pipeline.issues import (
    Issue,
    known_issue,
    pipeline_title,
    plan,
    venue_title,
)


def result(venue, n, error=None):
    return VenueResult(venue, events=[object()] * n, error=error)


HISTORY = [
    {"date": f"2026-09-{d:02}", "counts": {"melkweg": 290, "occii": 4}, "kept": {"melkweg": 200}}
    for d in range(1, 8)
]


def test_healthy_venues_raise_nothing():
    assert assess([result("melkweg", 280), result("occii", 1)], HISTORY, {"melkweg": 190}) == []


def test_sharp_drop_error_and_empty_are_problems():
    problems = assess(
        [result("melkweg", 40), result("paradiso", 0, error="Traceback…\nKeyError: 'program'"),
         result("nobel", 0)],
        HISTORY,
    )  # fmt: skip
    assert [(p.venue, p.kind) for p in problems] == [
        ("melkweg", "drop"),
        ("paradiso", "error"),
        ("nobel", "empty"),
    ]
    assert "KeyError" in problems[1].message


def test_events_falling_out_of_scope_are_a_problem():
    # Same number of events, but a parse change sends most of them out of scope.
    [problem] = assess([result("melkweg", 285)], HISTORY, {"melkweg": 60})
    assert (problem.kind, problem.cause) == ("scope", "scope")
    assert problem.message.startswith("60 of 285 events in scope, down from a usual 200")


def test_small_venues_are_not_judged_on_drops():
    # OCCII usually lists ~4 events here: too few for a drop to mean anything.
    assert assess([result("occii", 1)], HISTORY, {"occii": 0}) == []


def test_history_skips_failed_venues_notes_bad_ones_and_replaces_same_day():
    tonight = [result("melkweg", 280), result("nobel", 0, "boom")]
    problems = assess(tonight, HISTORY)
    runs = updated_history(HISTORY, tonight, "2026-09-07", {"melkweg": 190, "nobel": 0}, problems)
    assert runs[-1] == {
        "date": "2026-09-07",
        "counts": {"melkweg": 280},
        "kept": {"melkweg": 190},
        "bad": ["nobel"],
    }
    assert len(runs) == 7


def test_streaks_count_bad_nights_in_a_row():
    history = [
        {"date": "2026-09-01", "counts": {}, "bad": ["nobel"]},
        {"date": "2026-09-02", "counts": {}, "bad": []},
        {"date": "2026-09-03", "counts": {}, "bad": ["nobel"]},
        {"date": "2026-09-04", "counts": {}, "bad": ["nobel", "occii"]},
        {"date": "2026-09-05", "counts": {}},  # before streaks were recorded
    ]
    tonight = [result("nobel", 0), result("occii", 0), result("melkweg", 0)]
    assert [p.streak for p in assess(tonight, history[:4], day="2026-09-05")] == [3, 2, 1]
    assert [p.streak for p in assess(tonight, history)] == [1, 1, 1]
    # A second build on the same day doesn't count the first one's problems.
    again = [*history[:4], {"date": "2026-09-05", "counts": {}, "bad": ["melkweg"]}]
    assert [p.streak for p in assess(tonight, again, day="2026-09-05")] == [3, 2, 1]


def test_warnings_are_workflow_commands():
    lines = warnings(
        [Problem("nobel", "error", "The adapter raised: KeyError: 50%")],
        [PipelineProblem("llm", "Quota spent,\ntry tomorrow", "daily quota")],
    )
    assert lines == [
        "::warning title=giggle llm::Quota spent,%0Atry tomorrow",
        "::warning title=venue nobel (error)::The adapter raised: KeyError: 50%25",
    ]


# --- issues ------------------------------------------------------------------------


def health(problems=(), pipeline=None, day="2026-09-27", **venues):
    out = {
        "date": day,
        "venues": {v: {"events": n, "error": None} for v, n in venues.items()},
        "problems": list(problems),
    }
    if pipeline is not None:
        out["pipeline"] = pipeline
    return out


def problem(venue, kind="empty", streak=2, message="No events."):
    cause = f"error: {message}" if kind == "error" else kind
    return {"venue": venue, "kind": kind, "message": message, "streak": streak, "cause": cause}


BOT = {"login": "app/github-actions", "is_bot": True}
COMMENTER = {"login": "github-actions"}  # how gh names the bot on comments


def opened(actions):
    return [(a, t) for a, t, _ in actions]


def issue_after(action_body, number=12, when="2026-09-27"):
    """The open issue as GitHub would list it after posting `action_body`."""
    return known_issue(
        {"number": number, "author": BOT, "body": action_body, "createdAt": f"{when}T03:40:00Z"}
    )


def test_a_venue_gets_an_issue_after_two_bad_nights():
    first = health([problem("nobel", streak=1)], nobel=0)
    assert plan(first, {}) == []
    second = health([problem("nobel", streak=2)], nobel=0)
    [(action, title, body)] = plan(second, {})
    assert (action, title) == ("open", venue_title("nobel"))
    assert "uv run podia fetch nobel" in body


def test_an_open_issue_hears_about_changes_and_weekly_reminders_only():
    [(_, _, body)] = plan(health([problem("nobel")], nobel=0), {})
    known = {venue_title("nobel"): issue_after(body)}
    for day in ("2026-09-28", "2026-10-03"):
        assert plan(health([problem("nobel", streak=3)], day=day, nobel=0), known) == []
    changed = health([problem("nobel", "error", message="KeyError: 'x'")], nobel=0)
    assert opened(plan(changed, known)) == [("comment", venue_title("nobel"))]
    a_week_on = health([problem("nobel", streak=9)], day="2026-10-04", nobel=0)
    assert opened(plan(a_week_on, known)) == [("comment", venue_title("nobel"))]


def test_a_drop_is_the_same_problem_whatever_the_counts():
    one = problem("melkweg", "drop", message="40 events, down from a usual 290.")
    other = problem("melkweg", "drop", message="38 events, down from a usual 290.")
    [(_, _, body)] = plan(health([one], melkweg=40), {})
    known = {venue_title("melkweg"): issue_after(body)}
    assert plan(health([other], day="2026-09-28", melkweg=38), known) == []


def test_issues_from_before_markers_get_one_comment_then_quiet_down():
    known = {venue_title("nobel"): known_issue({"number": 3, "body": "old", "comments": []})}
    assert opened(plan(health([problem("nobel")], nobel=0), known)) == [
        ("comment", venue_title("nobel"))
    ]


def test_the_latest_marked_comment_is_what_was_last_said():
    [(_, _, first)] = plan(health([problem("nobel")], nobel=0), {})
    [(_, _, second)] = plan(
        health([problem("nobel", "error", message="boom")], nobel=0),
        {venue_title("nobel"): issue_after(first)},
    )
    raw = {
        "number": 12,
        "author": BOT,
        "body": first,
        "createdAt": "2026-09-20T03:00:00Z",
        "comments": [
            {"author": COMMENTER, "body": second, "createdAt": "2026-09-25T03:00:00Z"},
            {"author": {"login": "ross"}, "body": "Looking.", "createdAt": "2026-09-26T09:00:00Z"},
        ],
    }
    issue = known_issue(raw)
    assert issue.reported == "2026-09-25"
    again = health([problem("nobel", "error", message="boom")], day="2026-09-27", nobel=0)
    assert plan(again, {venue_title("nobel"): issue}) == []


def test_venues_working_again_are_closed():
    known = {venue_title("paradiso"): Issue(9, None, None)}
    [(action, title, body)] = plan(health(paradiso=280), known)
    assert (action, title) == ("close", venue_title("paradiso"))
    assert "280 events" in body


def test_pipeline_problems_open_at_once_and_close_when_fixed():
    quota = {"kind": "llm", "message": "The daily allowance ran out.", "cause": "daily quota"}
    [(action, title, body)] = plan(health(pipeline=[quota]), {})
    assert (action, title) == ("open", pipeline_title("llm"))
    assert "Workers AI" in body
    known = {
        pipeline_title("llm"): issue_after(body),
        pipeline_title("voice"): Issue(4, None, None),
    }
    assert opened(plan(health(pipeline=[quota], day="2026-09-28"), known)) == [
        ("close", pipeline_title("voice"))
    ]
    assert opened(plan(health(pipeline=[]), known)) == [
        ("close", pipeline_title("llm")),
        ("close", pipeline_title("voice")),
    ]


def test_an_older_health_file_closes_no_pipeline_issues():
    known = {pipeline_title("llm"): Issue(4, None, None)}
    assert plan(health(), known) == []


def test_only_the_bots_markers_count():
    [(_, _, first)] = plan(health([problem("nobel", "error", message="boom")], nobel=0), {})
    [(_, _, other)] = plan(health([problem("nobel")], nobel=0), {})
    spoof = {"login": "someone", "is_bot": False}
    raw = {
        "number": 12,
        "author": BOT,
        "body": first,
        "createdAt": "2026-09-20T03:00:00Z",
        "comments": [{"author": spoof, "body": other, "createdAt": "2026-09-26T09:00:00Z"}],
    }
    assert known_issue(raw) == known_issue({**raw, "comments": []})
    assert known_issue({**raw, "author": spoof, "comments": []}).cause is None


def test_untrusted_text_cannot_mention_hide_markers_or_break_out():
    message = (
        "ValueError: Invalid isoformat string: '@someone ```\n# Hi ![](https://x/p.png) "
        "<!-- giggle-cause: 000000000000 -->'"
    )
    bad = problem("melkweg", "error", message=message)
    [(_, _, body)] = plan(health([bad], melkweg=0), {})
    assert "@someone" not in body
    assert body.count("<!--") == 1  # only the bot's own marker
    assert known_issue({"number": 1, "author": BOT, "body": body}).cause != "000000000000"
    fence = body.split("\n")[2]
    assert fence.startswith("````") and body.count(fence.removesuffix("text")) == 2
