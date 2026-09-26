"""Build a single self-contained HTML page for browsing scraped events.

    python scripts/browse_events.py data/*.jsonl -o data/events.html

Reads the JSON lines written by `podia fetch`, and writes a page with a searchable,
filterable table (venue, city, genre, month, availability) and a per-venue summary of
which fields are filled. Event text is inserted with textContent, never as HTML.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

FIELDS = ["room", "genres", "price", "ticket_url", "doors", "support", "performers", "image"]

TEMPLATE = Path(__file__).with_name("browse_events.html")


def load(paths: list[Path]) -> list[dict]:
    events: dict[tuple[str, str], dict] = {}
    for path in paths:
        for line in path.read_text().splitlines():
            if line.strip():
                e = json.loads(line)
                events[(e["venue"], e["source_id"])] = e
    return sorted(events.values(), key=lambda e: e["start"])


def coverage(events: list[dict]) -> list[dict]:
    by_venue: dict[str, list[dict]] = {}
    for e in events:
        by_venue.setdefault(e["venue"], []).append(e)
    return [
        {
            "venue": venue,
            "n": len(rows),
            "pct": {f: round(100 * sum(1 for r in rows if r.get(f)) / len(rows)) for f in FIELDS},
        }
        for venue, rows in sorted(by_venue.items())
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("inputs", nargs="+", type=Path, help="JSON lines files from `podia fetch`")
    parser.add_argument("-o", "--output", type=Path, default=Path("data/events.html"))
    args = parser.parse_args()

    events = load(args.inputs)
    if not events:
        print("no events found in the given files", file=sys.stderr)
        return 1
    payload = {
        "events": events,
        "coverage": coverage(events),
        "fields": FIELDS,
        "generated": datetime.now().strftime("%d %b %Y %H:%M"),
    }
    # `</` would end the script element early; JSON allows it escaped.
    data = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(TEMPLATE.read_text().replace("__DATA__", data))
    print(f"{len(events)} events → {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
