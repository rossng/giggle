"""Fixture-replay helpers.

Each venue has recorded responses in `tests/fixtures/<slug>/` and a golden file
`tests/golden/<slug>.json` with the events parsed from them. Run with
`PODIA_UPDATE_GOLDEN=1` to rewrite golden files after an intentional change.
"""

from __future__ import annotations

import json
import os
from datetime import date
from pathlib import Path

import pytest

from podia import FetchOptions, Replay, get_venue

HERE = Path(__file__).parent


def replay_events(slug: str):
    """Parse a venue's recorded responses with the same options they were recorded with."""
    return replay(slug)[0]


def replay(slug: str):
    """The venue's recorded events, plus the first ones run through `details()` (as many as
    `podia record --details` saved event pages for; none for venues without details)."""
    directory = HERE / "fixtures" / slug
    meta = json.loads((directory / "meta.json").read_text())
    options = FetchOptions(since=date.fromisoformat(meta["since"]), max_pages=meta["max_pages"])
    fetch = Replay(directory)
    venue = get_venue(slug)
    events = list(venue.events(fetch, options))
    detailed = [venue.details(fetch, e) for e in events[: meta.get("details", 0)]]
    return events, detailed


def check_golden(slug: str, events) -> None:
    path = HERE / "golden" / f"{slug}.json"
    actual = [e.to_dict() for e in events]
    if os.environ.get("PODIA_UPDATE_GOLDEN") or not path.exists():
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(actual, indent=1, ensure_ascii=False, sort_keys=True) + "\n")
        return
    expected = json.loads(path.read_text())
    assert actual == expected, f"{slug}: parsed events differ from {path.name}"


@pytest.fixture
def golden():
    return check_golden
