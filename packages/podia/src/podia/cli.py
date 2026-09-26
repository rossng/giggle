"""Command line: `podia list`, `podia fetch <venue>... [--details [N]]`, `podia record <venue>`."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

from podia.http import Client, Recorder
from podia.venue import FetchOptions, all_venues, get_venue


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="podia", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="list known venues")

    fetch = sub.add_parser("fetch", help="print upcoming events as JSON lines")
    fetch.add_argument("venues", nargs="*", help="venue slugs (default: all)")
    fetch.add_argument("--max-pages", type=int, default=None)
    fetch.add_argument(
        "--details",
        type=int,
        nargs="?",
        const=-1,
        default=None,
        metavar="N",
        help="also read the event pages of the first N events per venue (default: all), "
        "for venues that have them",
    )

    record = sub.add_parser("record", help="save live responses as test fixtures")
    record.add_argument("venue")
    record.add_argument("--max-pages", type=int, default=2)
    record.add_argument("--out", type=Path, default=Path("tests/fixtures"))
    record.add_argument(
        "--details",
        type=int,
        default=3,
        metavar="N",
        help="event pages to record, for venues that have them (default: the first 3)",
    )

    args = parser.parse_args(argv)

    if args.command == "list":
        for slug, cls in all_venues().items():
            print(f"{slug:20} {cls.info.name} ({cls.info.city})")
        return 0

    if args.command == "fetch":
        slugs = args.venues or list(all_venues())
        options = FetchOptions(max_pages=args.max_pages)
        failed = False
        with Client() as client:
            for slug in slugs:
                venue = get_venue(slug)
                budget = args.details if venue.has_details else None
                try:
                    for event in venue.events(client, options):
                        if budget:  # -1 means every event
                            budget -= 1
                            try:
                                event = venue.details(client, event)
                            except Exception as exc:  # keep the listing's event
                                failed = True
                                print(f"podia: {slug}/{event.source_id}: {exc!r}", file=sys.stderr)
                        print(json.dumps(event.to_dict(), ensure_ascii=False))
                except BrokenPipeError:
                    # Output was closed early (e.g. `| head`); silence the flush at exit.
                    os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
                    return 0
                except Exception as exc:  # report and carry on with the other venues
                    failed = True
                    print(f"podia: {slug}: {exc!r}", file=sys.stderr)
        return 1 if failed else 0

    if args.command == "record":
        venue = get_venue(args.venue)
        directory = args.out / args.venue
        shutil.rmtree(directory, ignore_errors=True)  # no stale recordings left behind
        with Client() as client:
            recorder = Recorder(client, directory, redact=venue.redact)
            options = FetchOptions(max_pages=args.max_pages)
            events = list(venue.events(recorder, options))
            details = min(args.details, len(events)) if venue.has_details else 0
            for event in events[:details]:
                venue.details(recorder, event)
        meta: dict[str, object] = {"since": options.since.isoformat(), "max_pages": args.max_pages}
        if details:
            meta["details"] = details
        (directory / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
        print(f"recorded {len(recorder.index)} responses, {len(events)} events → {directory}")
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main())
