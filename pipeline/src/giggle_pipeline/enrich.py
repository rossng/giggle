"""Turn each gig's line-up into artist records, and gather what's known about them.

Artists are identified by their MusicBrainz ID where one matches, otherwise by their
normalised name. Gigs are handled soonest first, so when a night's request budget
runs out it's next week's artists that got looked up, not next year's.
"""

from __future__ import annotations

from typing import Any

from giggle_pipeline.lastfm import LastFM
from giggle_pipeline.musicbrainz import MusicBrainz, normalise
from giggle_pipeline.wikipedia import Wikipedia


def artist_key(name: str, match: dict[str, Any] | None) -> str:
    return f"mb:{match['mbid']}" if match else f"name:{normalise(name)}"


def enrich_artists(
    records: list[dict[str, Any]],
    mb: MusicBrainz,
    lastfm: LastFM | None = None,
    wikipedia: Wikipedia | None = None,
) -> dict[str, dict[str, Any]]:
    """Adds `artists` ([{key, name, role}]) to each gig record, and returns the artist
    records keyed by artist key: MusicBrainz match and details, Last.fm tags,
    listeners, bio and top tracks, and a Wikipedia summary, where available."""
    artists: dict[str, dict[str, Any]] = {}
    for record in sorted(records, key=lambda r: r["start"]):
        lineup = record["lineup"]
        hints = [*record.get("genres", []), *record.get("categories", [])]
        refs = []
        roles = [(n, "headliner") for n in lineup["headliners"]]
        roles += [(n, "support") for n in lineup["support"]]
        for name, role in roles:
            match = mb.match(name, hints)
            key = artist_key(name, match)
            entry = artists.get(key)
            if entry is None:
                entry = artists[key] = describe(name, match, mb, lastfm, wikipedia)
            if record["id"] not in entry["gigs"]:
                entry["gigs"].append(record["id"])
            if key not in {r["key"] for r in refs}:
                refs.append({"key": key, "name": name, "role": role})
        record["artists"] = refs
    return artists


def describe(
    name: str,
    match: dict[str, Any] | None,
    mb: MusicBrainz,
    lastfm: LastFM | None,
    wikipedia: Wikipedia | None,
) -> dict[str, Any]:
    details = mb.details(match["mbid"]) if match else None
    mbid = match["mbid"] if match else None
    info = lastfm.info(name, mbid) if lastfm else None
    if info and (info.get("bio") or "").startswith("There are multiple artists"):
        info = {**info, "bio": None}  # Last.fm merged namesakes: the bio may be anyone's
    return {
        "key": artist_key(name, match),
        "name": match["name"] if match else name,
        "match": match,
        "musicbrainz": details,
        "lastfm": info,
        "top_tracks": lastfm.top_tracks(name, mbid) if lastfm else None,
        "wikipedia": wikipedia.summary(details["links"]) if wikipedia and details else None,
        "gigs": [],
    }
