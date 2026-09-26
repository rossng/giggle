"""giggle-build: collect venue agendas, keep what giggle is about, and publish JSON.

    giggle-build --out data/site                      # live
    giggle-build --replay packages/podia/tests/fixtures --out data/site   # offline

Writes to --out:
  gigs.json            the events giggle keeps, with line-ups, plus venue details
  artists.json         everyone playing, with MusicBrainz details where matched
  excluded.json        everything left out, each with its reason
  health.json          per-venue counts, timings, errors and problems
  health-history.json  recent nightly counts, the baseline for spotting broken venues
  pronunciation.json   the announcers' lexicon (pronunciation.toml), for voices in the browser
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from giggle_pipeline import blurbs as blurbs_mod
from giggle_pipeline import health
from giggle_pipeline.cache import Cache
from giggle_pipeline.clips import render_intros
from giggle_pipeline.collect import collect_live, collect_replay
from giggle_pipeline.dedupe import merge_duplicates, place
from giggle_pipeline.details import fetch_details
from giggle_pipeline.enrich import enrich_artists, trusted_identity
from giggle_pipeline.lastfm import LastFM
from giggle_pipeline.lineup import fake_answer, parse_lineups
from giggle_pipeline.llm import LLM, FakeLLM, LLMError, WorkersAI
from giggle_pipeline.musicbrainz import MusicBrainz
from giggle_pipeline.scope import exclusion_reason, load_rules
from giggle_pipeline.voice import Lexicon
from giggle_pipeline.wikipedia import Wikipedia
from giggle_pipeline.ytmusic import ArtistLookup
from podia import Client, Event, all_venues

# Line-ups the model classes as these aren't what giggle is for.
LINEUP_EXCLUDE = {"club": "club night", "tribute": "tribute act", "not_music": "not music"}


def gig(event: Event, **extra: Any) -> dict[str, Any]:
    identity = {"id": f"{event.venue}:{event.source_id}", "place": place(event)}
    return {**identity, **event.to_dict(), **extra}


def load_dotenv(path: Path = Path(".env")) -> None:
    """Read KEY=value lines into the environment, without overriding what's set."""
    if path.exists():
        for line in path.read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep and not key.strip().startswith("#"):
                os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def make_llm(choice: str) -> LLM | None:
    if choice == "none":
        return None
    if choice == "fake":
        return FakeLLM(fake_answer)
    try:
        return WorkersAI.from_env()
    except LLMError as exc:
        if choice == "workers":
            raise
        print(f"llm: {exc}; using title rules (fake LLM) instead", file=sys.stderr)
        return FakeLLM(fake_answer)


def write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="giggle-build", description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=Path("data/site"))
    parser.add_argument("--replay", type=Path, help="podia fixtures directory: run offline")
    parser.add_argument("--history", type=Path, help="previous health-history.json")
    parser.add_argument("--since", type=date.fromisoformat, default=date.today())
    parser.add_argument("--venues", nargs="*", help="only these venue slugs")
    parser.add_argument(
        "--llm",
        choices=["auto", "workers", "fake", "none"],
        default="auto",
        help="auto: Workers AI if credentials are set, else title rules",
    )
    parser.add_argument("--llm-max-calls", type=int, default=200)
    parser.add_argument(
        "--mb-max-requests",
        type=int,
        default=600,
        help="MusicBrainz requests per run (1/s); the rest wait for the next run",
    )
    parser.add_argument(
        "--youtube-days",
        type=int,
        default=60,
        help="look up YouTube Music songs for artists playing within this many days",
    )
    parser.add_argument("--youtube-max-lookups", type=int, default=400)
    parser.add_argument(
        "--details-max-per-venue",
        type=int,
        default=40,
        help="event detail pages fetched per venue per run (new and soon events first)",
    )
    parser.add_argument("--cache", type=Path, default=Path("data/cache/pipeline.sqlite"))
    args = parser.parse_args(argv)
    load_dotenv()

    if args.replay:
        results = collect_replay(args.replay, args.venues)
    else:
        results = collect_live(args.since, args.venues)

    # Detail pages (rooms, prices, show times) only for new or soon events; replays use
    # what's cached.
    cache = Cache(args.cache)
    fetch_factory = None if args.replay else (lambda slug: Client())
    results = fetch_details(results, fetch_factory, cache, max_per_venue=args.details_max_per_venue)

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

    llm = make_llm(args.llm)
    records = [gig(e) for e in gigs]
    lineups = parse_lineups(records, llm, cache, max_calls=args.llm_max_calls)
    kept_records = []
    for record in records:
        record["lineup"] = lineups[record["id"]]
        reason = LINEUP_EXCLUDE.get(record["lineup"]["kind"])
        if reason:
            excluded.append({**record, "reason": f"{reason} (from line-up)"})
        else:
            kept_records.append(record)

    # Replays stay offline: artists come only from what's already cached.
    offline = bool(args.replay)
    mb = MusicBrainz(cache, max_requests=0 if offline else args.mb_max_requests)
    lastfm_key = os.environ.get("LASTFM_API_KEY") or None  # CI passes unset secrets as ""
    lastfm = LastFM(cache, lastfm_key, max_requests=0 if offline else 1500)
    wikipedia = Wikipedia(cache, max_requests=0 if offline else 1000)
    youtube = ArtistLookup(
        args.cache.parent / "ytmusic.json",
        max_lookups=0 if offline else args.youtube_max_lookups,
    )
    until = (args.since + timedelta(days=args.youtube_days)).isoformat()
    try:
        artists = enrich_artists(kept_records, mb, lastfm, wikipedia, youtube, until)
    finally:
        youtube.save()

    # Announcer blurbs (LLM, grounded in the facts above) and their voice clips, soonest
    # gigs first; clips land in <out>/voice/ and are never re-rendered.
    # Only artists the radio can play get introduced, so only they need blurbs and clips.
    # enrich_artists adds artists soonest gig first.
    # Only described when we're sure who they are (see trusted_identity).
    order = [
        k
        for k, a in artists.items()
        if (a.get("youtube") or {}).get("songs") and trusted_identity(a)
    ]
    blurb_llm = FakeLLM(blurbs_mod.fake_answer) if llm and llm.name == "fake" else llm
    blurbs = blurbs_mod.write_blurbs(artists, blurb_llm, cache, order, max_calls=args.llm_max_calls)
    fake = offline or blurb_llm is None or blurb_llm.name == "fake"
    intros = render_intros(artists, blurbs, order, args.out, max_renders=0 if fake else 300)
    for key, artist in artists.items():
        artist["blurbs"] = blurbs.get(key, [])
        artist["announce"] = [
            {"text": c["text"], "clip": c["file"], "seconds": c["seconds"], "voice": c["voice"]}
            for c in intros.get(key, [])
        ]
    cache.close()

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
            "gigs": kept_records,
        },
    )
    write_json(args.out / "artists.json", {"artists": artists})
    write_json(args.out / "excluded.json", sorted(excluded, key=lambda e: e["start"]))
    write_json(args.out / "health.json", health.report(results, problems, today))
    # The browser's Kokoro says the live lines (gig, track names), so it needs the same
    # pronunciations as the pre-rendered clips.
    lexicon = [asdict(e) for e in Lexicon.load().entries]
    write_json(args.out / "pronunciation.json", {"names": lexicon})
    if not args.replay:  # replayed fixtures would pollute the baseline
        runs = health.updated_history(history, results, today)
        write_json(args.out / "health-history.json", runs)

    print(f"{'venue':18}{'events':>7}{'kept':>6}{'secs':>7}  status")
    kept_per_venue = {r.venue: 0 for r in results}
    for record in kept_records:
        kept_per_venue[record["venue"]] += 1
    problem_by_venue = {p.venue: p for p in problems}
    for r in results:
        status = problem_by_venue[r.venue].kind if r.venue in problem_by_venue else "ok"
        print(f"{r.venue:18}{len(r.events):>7}{kept_per_venue[r.venue]:>6}{r.seconds:>7}  {status}")
    reasons: dict[str, int] = {}
    for e in excluded:
        key = e["reason"].split(" of ")[0]
        reasons[key] = reasons.get(key, 0) + 1
    sources: dict[str, int] = {}
    for record in kept_records:
        sources[record["lineup"]["source"]] = sources.get(record["lineup"]["source"], 0) + 1
    print("\nline-ups: " + ", ".join(f"{n} from {s}" for s, n in sources.items())
          + f" ({getattr(llm, 'calls', 0)} LLM calls, {cache.hits} cached)")  # fmt: skip
    matched = sum(1 for a in artists.values() if a["match"])
    with_lastfm = sum(1 for a in artists.values() if a["lastfm"])
    with_wiki = sum(1 for a in artists.values() if a["wikipedia"])
    with_songs = sum(1 for a in artists.values() if (a.get("youtube") or {}).get("songs"))
    with_blurbs = sum(1 for a in artists.values() if a["blurbs"])
    with_clips = sum(1 for a in artists.values() if a["announce"])
    print(
        f"artists: {len(artists)}; {matched} matched on MusicBrainz, {with_lastfm} on Last.fm, "
        f"{with_wiki} with a Wikipedia summary, {with_songs} with YouTube Music songs "
        f"({mb.requests} MusicBrainz requests, {youtube.lookups} YouTube Music lookups)"
    )
    print(f"announcer: {with_blurbs} artists with blurbs, {with_clips} with voice clips")
    if mb.sheds:
        print(f"musicbrainz: {mb.sheds} busy (shed) search responses retried", file=sys.stderr)
    if mb.outages:
        state = "gave up for this run" if mb.unavailable else "recovered"
        print(f"musicbrainz: {mb.outages} failed lookups; {state}", file=sys.stderr)
    print(f"{len(kept_records)} gigs kept, {len(excluded)} left out: " + ", ".join(
        f"{n} {reason}" for reason, n in sorted(reasons.items(), key=lambda x: -x[1])))  # fmt: skip
    for p in problems:
        print(f"problem: {p.venue}: {p.message}", file=sys.stderr)

    # Broken venues are reported via health.json; only fail when nothing usable came out.
    return 0 if kept_records else 1


if __name__ == "__main__":
    sys.exit(main())
