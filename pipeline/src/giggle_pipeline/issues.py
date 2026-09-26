"""giggle-issues: keep one GitHub issue per broken venue, from health.json.

    giggle-issues data/site/health.json            # uses the gh CLI and GH_REPO / the cwd repo
    giggle-issues data/site/health.json --dry-run  # print what would happen

A problem opens an issue, or comments on the open one if it's already known. When the
venue works again, the issue gets a closing comment and is closed.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

LABEL = "venue-health"


def title(venue: str) -> str:
    return f"Venue scraper needs attention: {venue}"


def plan(health: dict, open_issues: dict[str, int]) -> list[tuple[str, str, str]]:
    """Actions as (action, venue, body): action is "open", "comment" or "close"."""
    problems = {p["venue"]: p for p in health["problems"]}
    actions = []
    for venue, stats in health["venues"].items():
        problem = problems.get(venue)
        if problem:
            body = (
                f"**{health['date']}**: {problem['message']}\n\n"
                f"Reproduce locally with `uv run podia fetch {venue}`."
            )
            if stats.get("error"):
                body += f"\n\n```\n{stats['error'].strip()}\n```"
            actions.append(("comment" if venue in open_issues else "open", venue, body))
        elif venue in open_issues:
            actions.append(
                ("close", venue, f"**{health['date']}**: working again, {stats['events']} events.")
            )
    return actions


def gh(*args: str) -> str:
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="giggle-issues", description=__doc__.splitlines()[0])
    parser.add_argument("health", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    health = json.loads(args.health.read_text())
    listed = json.loads(
        gh("issue", "list", "--label", LABEL, "--state", "open", "--json", "number,title")
    ) if not args.dry_run else []  # fmt: skip
    by_title = {i["title"]: i["number"] for i in listed}
    open_issues = {v: by_title[title(v)] for v in health["venues"] if title(v) in by_title}
    actions = plan(health, open_issues)
    if not args.dry_run and any(a == "open" for a, _, _ in actions):
        gh("label", "create", LABEL, "--color", "B60205", "--force",
           "--description", "A venue scraper is failing or returning too few events")  # fmt: skip

    for action, venue, body in actions:
        print(f"{action}: {venue}")
        if args.dry_run:
            print("  " + body.replace("\n", "\n  "))
        elif action == "open":
            gh("issue", "create", "--title", title(venue), "--label", LABEL, "--body", body)
        elif action == "comment":
            gh("issue", "comment", str(open_issues[venue]), "--body", body)
        else:
            gh("issue", "close", str(open_issues[venue]), "--comment", body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
