"""giggle-build: collect venue agendas, keep what giggle is about, and publish JSON.

    giggle-build --out data/site                      # live
    giggle-build --replay packages/podia/tests/fixtures --out data/site   # offline

Writes to --out:
  gigs.json            the events giggle keeps, plus venue details
  excluded.json        everything left out, each with its reason
  health.json          per-venue counts, timings, errors and problems
  health-history.json  recent nightly counts, the baseline for spotting broken venues
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from datetime import date, datetime
from pathlib import Path
from typing import Any

from giggle_pipeline import health
from giggle_pipeline.collect import collect_live, collect_replay
from giggle_pipeline.dedupe import merge_duplicates, place
from giggle_pipeline.scope import exclusion_reason, load_rules
from podia import Event, all_venues


def gig(event: Event, **extra: Any) -> dict[str, Any]:
    identity = {"id": f"{event.venue}:{event.source_id}", "place": place(event)}
    return {**identity, **event.to_dict(), **extra}


def write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="giggle-build", description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=Path("data/site"))
    parser.add_argument("--replay", type=Path, help="podia fixtures directory: run offline")
    parser.add_argument("--history", type=Path, help="previous health-history.json")
    parser.add_argument("--since", type=date.fromisoformat, default=date.today())
    parser.add_argument("--venues", nargs="*", help="only these venue slugs")
    args = parser.parse_args(argv)

    if args.replay:
        results = collect_replay(args.replay, args.venues)
    else:
        results = collect_live(args.since, args.venues)

    rules = load_rules()
    kept_by_scope: list[Event] = []
    excluded: list[dict] = []
    for r in results:
        for event in r.events:
            reason = exclusion_reason(event, rules)
            if reason:
                excluded.append(gig(event, reason=reason))
            else:
                kept_by_scope.append(event)

    gigs, merged = merge_duplicates(kept_by_scope)
    for dropped, twin in merged:
        excluded.append(gig(dropped, reason=f"duplicate of {twin.venue}:{twin.source_id}"))

    history: list[dict] = []
    if args.history and args.history.exists():
        history = json.loads(args.history.read_text())
    problems = health.assess(results, history)
    today = args.since.isoformat()

    args.out.mkdir(parents=True, exist_ok=True)
    venues = {slug: asdict(cls.info) for slug, cls in all_venues().items()}
    write_json(
        args.out / "gigs.json",
        {
            "generated": datetime.now().astimezone().isoformat(timespec="seconds"),
            "since": today,
            "venues": venues,
            "gigs": [gig(e) for e in gigs],
        },
    )
    write_json(args.out / "excluded.json", sorted(excluded, key=lambda e: e["start"]))
    write_json(args.out / "health.json", health.report(results, problems, today))
    if not args.replay:  # replayed fixtures would pollute the baseline
        runs = health.updated_history(history, results, today)
        write_json(args.out / "health-history.json", runs)

    print(f"{'venue':18}{'events':>7}{'kept':>6}{'secs':>7}  status")
    kept_per_venue = {r.venue: sum(1 for e in gigs if e.venue == r.venue) for r in results}
    problem_by_venue = {p.venue: p for p in problems}
    for r in results:
        status = problem_by_venue[r.venue].kind if r.venue in problem_by_venue else "ok"
        print(f"{r.venue:18}{len(r.events):>7}{kept_per_venue[r.venue]:>6}{r.seconds:>7}  {status}")
    reasons: dict[str, int] = {}
    for e in excluded:
        key = e["reason"].split(" of ")[0]
        reasons[key] = reasons.get(key, 0) + 1
    print(f"\n{len(gigs)} gigs kept, {len(excluded)} left out: " + ", ".join(
        f"{n} {reason}" for reason, n in sorted(reasons.items(), key=lambda x: -x[1])))  # fmt: skip
    for p in problems:
        print(f"problem: {p.venue}: {p.message}", file=sys.stderr)

    # Broken venues are reported via health.json; only fail when nothing usable came out.
    return 0 if gigs else 1


if __name__ == "__main__":
    sys.exit(main())
