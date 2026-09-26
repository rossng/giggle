"""Spot venues whose scraper has probably broken.

A venue needs attention when its adapter raised, returned nothing, or returned far
fewer events than it usually does. "Usually" is the median of recent nightly runs, so
one quiet week doesn't raise an alarm but a redesigned website does.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from statistics import median

from giggle_pipeline.collect import VenueResult

HISTORY_RUNS = 30  # nightly runs kept
BASELINE_RUNS = 7  # runs the "usual" count is taken from
DROP_RATIO = 0.5  # fewer than half the usual count is a problem
MIN_BASELINE = 10  # venues that usually list fewer events are too noisy to judge


@dataclass(frozen=True)
class Problem:
    venue: str
    kind: str  # "error" | "empty" | "drop"
    message: str


def assess(results: list[VenueResult], history: list[dict]) -> list[Problem]:
    problems = []
    for r in results:
        if r.error:
            last_line = r.error.strip().splitlines()[-1]
            problems.append(Problem(r.venue, "error", f"The adapter raised: {last_line}"))
            continue
        if not r.events:
            problems.append(Problem(r.venue, "empty", "The adapter returned no events."))
            continue
        recent = history[-BASELINE_RUNS:]
        past = [run["counts"][r.venue] for run in recent if r.venue in run["counts"]]
        usual = median(past) if past else 0
        if usual >= MIN_BASELINE and len(r.events) < usual * DROP_RATIO:
            problems.append(
                Problem(
                    r.venue,
                    "drop",
                    f"{len(r.events)} events, down from a usual {usual:g} "
                    f"(median of the last {len(past)} runs).",
                )
            )
    return problems


def updated_history(history: list[dict], results: list[VenueResult], day: str) -> list[dict]:
    """Append tonight's counts. Failed venues are left out so they don't lower the baseline."""
    counts = {r.venue: len(r.events) for r in results if not r.error and r.events}
    runs = [run for run in history if run["date"] != day] + [{"date": day, "counts": counts}]
    return runs[-HISTORY_RUNS:]


def report(results: list[VenueResult], problems: list[Problem], day: str) -> dict:
    return {
        "date": day,
        "venues": {
            r.venue: {"events": len(r.events), "seconds": r.seconds, "error": r.error}
            for r in results
        },
        "problems": [asdict(p) for p in problems],
    }
