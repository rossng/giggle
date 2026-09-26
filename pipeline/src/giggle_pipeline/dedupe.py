"""Merge listings of the same show published by more than one venue.

Muziekgebouw lists the Bimhuis's concerts (the Bimhuis is in its building), and
promoters' own listings can overlap. Two events from different venues are the same show
when they happen at the same place on the same day with near-identical titles.
"""

from __future__ import annotations

import re
import unicodedata

from podia import Event

# (venue, room) pairs that are really another venue.
PLACES = {("muziekgebouw", "bimhuis"): "bimhuis"}

_WORD = re.compile(r"[a-z0-9]+")
_FILLER = {"the", "de", "het", "en", "and", "live", "presents", "ft", "feat", "w"}


def place(event: Event) -> str:
    return PLACES.get((event.venue, (event.room or "").lower()), event.venue)


def title_words(title: str) -> frozenset[str]:
    text = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode().lower()
    return frozenset(w for w in _WORD.findall(text) if w not in _FILLER)


def same_show(a: Event, b: Event) -> bool:
    # A venue never lists one show twice; its separate listings on one night are separate
    # acts, often a festival's ("Bnnyhunna • Haarlem Vinyl Festival", "Janne Schra • …").
    if a.venue == b.venue:
        return False
    if place(a) != place(b) or a.start.date() != b.start.date():
        return False
    wa, wb = title_words(a.title), title_words(b.title)
    if not wa or not wb:
        return False
    return len(wa & wb) / min(len(wa), len(wb)) >= 0.6


def richness(event: Event) -> int:
    fields = (
        event.room, event.genres, event.price, event.ticket_url, event.doors,
        event.support, event.performers, event.image, event.description,
    )  # fmt: skip
    # Prefer the venue that is the actual place: it knows its own room and times best.
    return sum(bool(f) for f in fields) + (2 if place(event) == event.venue else 0)


def merge_duplicates(events: list[Event]) -> tuple[list[Event], list[tuple[Event, Event]]]:
    """Keep the richest listing of each show. Returns (kept, [(dropped, kept_instead)])."""
    by_day: dict[tuple[str, object], list[Event]] = {}
    for event in sorted(events, key=richness, reverse=True):
        by_day.setdefault((place(event), event.start.date()), []).append(event)

    kept: list[Event] = []
    merged: list[tuple[Event, Event]] = []
    for group in by_day.values():
        chosen: list[Event] = []
        for event in group:
            twin = next((c for c in chosen if same_show(c, event)), None)
            if twin is None:
                chosen.append(event)
            else:
                merged.append((event, twin))
        kept.extend(chosen)
    kept.sort(key=lambda e: (e.start, e.venue, e.title))
    return kept, merged
