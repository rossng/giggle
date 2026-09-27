"""Spot venues whose scraper has probably broken, and a pipeline that ran degraded.

A venue needs attention when its adapter raised, returned nothing, or returned far
fewer events than it usually does, or far fewer that giggle keeps (a parse change can
push events out of scope without changing the total). "Usually" is the median of recent
nightly runs, so one quiet week doesn't raise an alarm but a redesigned website does.
Each problem carries its streak, the nights in a row it has been seen, so a one-night
blip can be told from a broken venue.

Pipeline problems are the build's own: an LLM quota spent, a lookup service that
stopped answering, clips that couldn't be rendered. The build would otherwise carry on
quietly with less.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from statistics import median

from giggle_pipeline.collect import VenueResult

HISTORY_RUNS = 30  # nightly runs kept
BASELINE_RUNS = 7  # runs the "usual" count is taken from
DROP_RATIO = 0.5  # fewer than half the usual count is a problem
MIN_BASELINE = 10  # venues that usually list fewer events are too noisy to judge
PIPELINE_KINDS = ("llm", "ytmusic", "voice", "musicbrainz")


@dataclass(frozen=True)
class Problem:
    venue: str
    kind: str  # "error" | "empty" | "drop" | "scope"
    message: str
    streak: int = 1  # nights in a row this venue has had a problem, tonight included

    @property
    def cause(self) -> str:
        """What's wrong, without tonight's numbers: whether it has changed since the last
        report. An error's cause is its message; a drop is a drop, whatever the counts."""
        return f"error: {self.message}" if self.kind == "error" else self.kind


@dataclass(frozen=True)
class PipelineProblem:
    kind: str  # one of PIPELINE_KINDS
    message: str
    cause: str  # what's wrong, without tonight's numbers (see Problem.cause)


def _usual(history: list[dict], field: str, venue: str) -> tuple[float, int]:
    past = [run[field][venue] for run in history[-BASELINE_RUNS:] if venue in run.get(field, {})]
    return (median(past) if past else 0), len(past)


def _dropped(now: int, usual: float) -> bool:
    return usual >= MIN_BASELINE and now < usual * DROP_RATIO


def assess(
    results: list[VenueResult],
    history: list[dict],
    kept: dict[str, int] | None = None,
    day: str | None = None,
) -> list[Problem]:
    """Tonight's venue problems. `kept` is each venue's in-scope event count; `day` is
    tonight's date, left out of the streak if the history already has it."""
    kept = kept or {}
    past_runs = [run for run in history if run["date"] != day]
    problems = []
    for r in results:
        events, runs = _usual(past_runs, "counts", r.venue)
        in_scope, scope_runs = _usual(past_runs, "kept", r.venue)
        if r.error:
            last_line = r.error.strip().splitlines()[-1]
            kind, message = "error", f"The adapter raised: {last_line}"
        elif not r.events:
            kind, message = "empty", "The adapter returned no events."
        elif _dropped(len(r.events), events):
            kind = "drop"
            message = (
                f"{len(r.events)} events, down from a usual {events:g} "
                f"(median of the last {runs} runs)."
            )
        elif r.venue in kept and _dropped(kept[r.venue], in_scope):
            kind = "scope"
            message = (
                f"{kept[r.venue]} of {len(r.events)} events in scope, down from a usual "
                f"{in_scope:g} (median of the last {scope_runs} runs): check the parsing "
                "against scope.toml."
            )
        else:
            continue
        problems.append(Problem(r.venue, kind, message, _streak(past_runs, r.venue)))
    return problems


def _streak(past_runs: list[dict], venue: str) -> int:
    streak = 1
    for run in reversed(past_runs):
        if venue not in run.get("bad", ()):
            break
        streak += 1
    return streak


def updated_history(
    history: list[dict],
    results: list[VenueResult],
    day: str,
    kept: dict[str, int] | None = None,
    problems: list[Problem] = (),
) -> list[dict]:
    """Append tonight's counts. Failed venues are left out so they don't lower the
    baseline; venues with a problem are listed under "bad", for the streaks."""
    ok = {r.venue for r in results if not r.error and r.events}
    run = {
        "date": day,
        "counts": {r.venue: len(r.events) for r in results if r.venue in ok},
        "kept": {v: n for v, n in (kept or {}).items() if v in ok},
        "bad": sorted({p.venue for p in problems}),
    }
    runs = [past for past in history if past["date"] != day] + [run]
    return runs[-HISTORY_RUNS:]


def report(
    results: list[VenueResult],
    problems: list[Problem],
    day: str,
    pipeline: list[PipelineProblem] = (),
    kept: dict[str, int] | None = None,
) -> dict:
    kept = kept or {}
    return {
        "date": day,
        "venues": {
            r.venue: {
                "events": len(r.events),
                "kept": kept.get(r.venue, 0),
                "seconds": r.seconds,
                "error": r.error,
            }
            for r in results
        },
        "problems": [{**asdict(p), "cause": p.cause} for p in problems],
        "pipeline": [asdict(p) for p in pipeline],
    }


def warnings(problems: list[Problem], pipeline: list[PipelineProblem]) -> list[str]:
    """GitHub Actions workflow commands that put each problem on the run's summary."""
    titled = [(f"giggle {p.kind}", p.message) for p in pipeline]
    titled += [(f"venue {p.venue} ({p.kind})", p.message) for p in problems]
    return [f"::warning title={_escape(t, True)}::{_escape(m)}" for t, m in titled]


def _escape(text: str, property: bool = False) -> str:
    text = text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    return text.replace(":", "%3A").replace(",", "%2C") if property else text
