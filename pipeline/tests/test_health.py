from giggle_pipeline.collect import VenueResult
from giggle_pipeline.health import assess, updated_history
from giggle_pipeline.issues import plan


def result(venue, n, error=None):
    return VenueResult(venue, events=[object()] * n, error=error)


HISTORY = [{"date": f"2026-09-{d:02}", "counts": {"melkweg": 290, "occii": 4}} for d in range(1, 8)]


def test_healthy_venues_raise_nothing():
    assert assess([result("melkweg", 280), result("occii", 1)], HISTORY) == []


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


def test_small_venues_are_not_judged_on_drops():
    # OCCII usually lists ~4 events here: too few for a drop to mean anything.
    assert assess([result("occii", 1)], HISTORY) == []


def test_history_skips_failed_venues_and_replaces_same_day():
    tonight = [result("melkweg", 280), result("nobel", 0, "boom")]
    runs = updated_history(HISTORY, tonight, "2026-09-07")
    assert runs[-1] == {"date": "2026-09-07", "counts": {"melkweg": 280}}
    assert len(runs) == 7


def test_issue_plan_opens_comments_and_closes():
    health = {
        "date": "2026-09-27",
        "venues": {
            "melkweg": {"events": 40, "error": None},
            "nobel": {"events": 0, "error": None},
            "paradiso": {"events": 280, "error": None},
        },
        "problems": [
            {"venue": "melkweg", "kind": "drop", "message": "40 events, down from 290."},
            {"venue": "nobel", "kind": "empty", "message": "No events."},
        ],
    }
    actions = plan(health, open_issues={"nobel": 12, "paradiso": 9})
    assert [(a, v) for a, v, _ in actions] == [
        ("open", "melkweg"),
        ("comment", "nobel"),
        ("close", "paradiso"),
    ]
