"""giggle-issues: keep one GitHub issue per broken venue and per pipeline problem, from
health.json.

    giggle-issues data/site/health.json            # uses the gh CLI and GH_REPO / the cwd repo
    giggle-issues data/site/health.json --dry-run  # print what would happen

A venue gets an issue once it has had a problem two nights in a row (one bad night is
usually the venue's site having a moment); a pipeline problem (LLM, YouTube Music, voice
clips, MusicBrainz) gets one straight away. While an issue is open it gets a comment
when the problem changes, or a reminder after a week, not every night. When the venue or
the pipeline step works again, the issue gets a closing comment and is closed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from giggle_pipeline.health import PIPELINE_KINDS

VENUE_LABEL = "venue-health"
PIPELINE_LABEL = "pipeline-health"
LABELS = {
    VENUE_LABEL: "A venue scraper is failing or returning too few events",
    PIPELINE_LABEL: "The nightly build ran degraded (LLM, YouTube Music, voice, MusicBrainz)",
}
OPEN_AFTER_NIGHTS = 2  # a venue's problem streak before it gets an issue
REMIND_AFTER_DAYS = 7  # an unchanged problem is mentioned again after this long
_MARKER = re.compile(r"<!-- giggle-cause: ([0-9a-f]+) -->")
HINTS = {
    "llm": "Line-ups fell back to title rules and blurbs wait for a later night. "
    "Check Workers AI usage in the Cloudflare dashboard.",
    "ytmusic": 'Lookups stopped for the night and no "not found" answers were cached. '
    "ytmusicapi may need an update.",
    "voice": "Existing clips were still used; new intros wait for a night that can render.",
    "musicbrainz": "Unmatched artists are looked up again on the next run.",
}


def venue_title(venue: str) -> str:
    return f"Venue scraper needs attention: {venue}"


def pipeline_title(kind: str) -> str:
    return f"Pipeline needs attention: {kind}"


@dataclass(frozen=True)
class Issue:
    number: int
    cause: str | None  # the hash in the latest report's marker
    reported: str | None  # when that report was posted (ISO date)


def known_issue(raw: dict[str, Any]) -> Issue:
    """An open issue from `gh issue list --json number,body,createdAt,comments`: what it
    last reported, from the marker in its body or latest marked comment."""
    posts = [raw, *(raw.get("comments") or [])]
    for post in reversed(posts):
        marker = _MARKER.search(post.get("body") or "")
        if marker:
            return Issue(raw["number"], marker.group(1), (post.get("createdAt") or "")[:10])
    return Issue(raw["number"], None, None)


def _hash(cause: str) -> str:
    return hashlib.sha256(cause.encode()).hexdigest()[:12]


def _marked(body: str, cause: str) -> str:
    return f"{body}\n\n<!-- giggle-cause: {_hash(cause)} -->"


def _report(cause: str, issue: Issue | None, day: str, ready: bool) -> str | None:
    """ "open", "comment" or None (nothing new to say)."""
    if issue is None:
        return "open" if ready else None
    if issue.cause != _hash(cause) or not issue.reported:
        return "comment"
    days = (date.fromisoformat(day) - date.fromisoformat(issue.reported)).days
    return "comment" if days >= REMIND_AFTER_DAYS else None


def plan(health: dict, open_issues: dict[str, Issue]) -> list[tuple[str, str, str]]:
    """Actions as (action, issue title, body): action is "open", "comment" or "close"."""
    day = health["date"]
    actions = []
    problems = {p["venue"]: p for p in health["problems"]}
    for venue, stats in health["venues"].items():
        title, problem = venue_title(venue), problems.get(venue)
        issue = open_issues.get(title)
        if problem:
            cause = problem.get("cause") or problem["kind"]
            action = _report(cause, issue, day, problem.get("streak", 1) >= OPEN_AFTER_NIGHTS)
            if action:
                body = (
                    f"**{day}**: {problem['message']}\n\n"
                    f"Reproduce locally with `uv run podia fetch {venue}`."
                )
                if stats.get("error"):
                    body += f"\n\n```\n{stats['error'].strip()}\n```"
                actions.append((action, title, _marked(body, cause)))
        elif issue:
            actions.append(("close", title, f"**{day}**: working again, {stats['events']} events."))

    if "pipeline" not in health:  # from a build that didn't check its own steps
        return actions
    reported = {p["kind"]: p for p in health["pipeline"]}
    for kind in dict.fromkeys([*PIPELINE_KINDS, *reported]):
        title, problem = pipeline_title(kind), reported.get(kind)
        issue = open_issues.get(title)
        if problem:
            action = _report(problem["cause"], issue, day, ready=True)
            if action:
                body = f"**{day}**: {problem['message']}\n\n{HINTS.get(kind, '')}".strip()
                actions.append((action, title, _marked(body, problem["cause"])))
        elif issue:
            actions.append(("close", title, f"**{day}**: this step worked again."))
    return actions


def gh(*args: str) -> str:
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def list_open(label: str) -> list[dict[str, Any]]:
    fields = "number,title,body,createdAt,comments"
    return json.loads(
        gh("issue", "list", "--label", label, "--state", "open", "--limit", "200", "--json", fields)
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="giggle-issues", description=__doc__.splitlines()[0])
    parser.add_argument("health", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    health = json.loads(args.health.read_text())
    listed = [] if args.dry_run else [i for label in LABELS for i in list_open(label)]
    open_issues = {i["title"]: known_issue(i) for i in listed}
    actions = plan(health, open_issues)
    for label, description in LABELS.items():
        prefix = pipeline_title("") if label == PIPELINE_LABEL else venue_title("")
        opening = any(a == "open" and t.startswith(prefix) for a, t, _ in actions)
        if opening and not args.dry_run:
            gh("label", "create", label, "--color", "B60205", "--force",
               "--description", description)  # fmt: skip

    for action, title, body in actions:
        print(f"{action}: {title}")
        if args.dry_run:
            print("  " + body.replace("\n", "\n  "))
        elif action == "open":
            label = PIPELINE_LABEL if title.startswith(pipeline_title("")) else VENUE_LABEL
            gh("issue", "create", "--title", title, "--label", label, "--body", body)
        elif action == "comment":
            gh("issue", "comment", str(open_issues[title].number), "--body", body)
        else:
            gh("issue", "close", str(open_issues[title].number), "--comment", body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
