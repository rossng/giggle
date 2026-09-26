"""Throwaway preview of the radio: the next few weeks of gigs, played through YouTube.

    python scripts/radio_preview.py --days 14     # writes data/radio/index.html

Artists come from giggle_pipeline.artists (simple title rules) and their songs from
YouTube Music (cached in data/cache/ytmusic.json, so re-runs only look up new names).
The page must be served over http (YouTube embeds refuse file:// pages): `make radio`.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from giggle_pipeline.artists import artists_for
from giggle_pipeline.ytmusic import ArtistLookup

TEMPLATE = Path(__file__).with_name("radio_preview.html")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--site", type=Path, default=Path("data/site"))
    parser.add_argument("--days", type=int, default=14)
    parser.add_argument("--out", type=Path, default=Path("data/radio/index.html"))
    parser.add_argument("--cache", type=Path, default=Path("data/cache/ytmusic.json"))
    args = parser.parse_args()

    site = json.loads((args.site / "gigs.json").read_text())
    today = date.today()
    end = (today + timedelta(days=args.days)).isoformat()
    gigs = [g for g in site["gigs"] if today.isoformat() <= g["start"][:10] < end]

    lookup = ArtistLookup(args.cache)
    queue, unmatched = [], []
    try:
        for i, gig in enumerate(gigs, 1):
            for name in artists_for(gig):
                found = lookup.find(name)
                if found and found["songs"]:
                    queue.append({"parsed": name, "artist": found, "gig": gig})
                else:
                    unmatched.append({"name": name, "title": gig["title"], "venue": gig["venue"]})
            if lookup.lookups and i % 10 == 0:
                print(f"  {i}/{len(gigs)} gigs, {lookup.lookups} new lookups", file=sys.stderr)
                lookup.save()
    finally:
        lookup.save()

    payload = {
        "generated": datetime.now().strftime("%d %b %Y %H:%M"),
        "days": args.days,
        "venues": site["venues"],
        "gigs": len(gigs),
        "queue": queue,
        "unmatched": unmatched,
    }
    data = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(TEMPLATE.read_text().replace("__DATA__", data))
    artists = {q["artist"]["browseId"] for q in queue}
    print(
        f"{len(gigs)} gigs → {len(artists)} artists found on YouTube Music, "
        f"{len(unmatched)} names not found → {args.out}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
