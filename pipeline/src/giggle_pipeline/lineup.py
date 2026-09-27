"""Who is actually playing: the line-up of each gig, read from its listing by an LLM.

Venue titles mix artist names with tour names, festival names, series labels and
notes ("Discover: Ronker + Grote Geelstaart", "KRONKEL FESTIVAL" with the line-up in
the description). The model returns headliners and support acts per gig, plus what
kind of event it is. Its answers are cached as given and checked on every build: names
must appear in the listing text, so it can't invent artists, and event names,
presenters ("X & Y present:") and filler words are dropped. Where the model fails, the
title rules in `artists` stand in.
"""

from __future__ import annotations

import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from giggle_pipeline.artists import names_from_text
from giggle_pipeline.cache import Cache
from giggle_pipeline.llm import (
    LLM,
    MODELS,
    LLMError,
    QuotaExhausted,
    cached_answer,
    store_answer,
)
from giggle_pipeline.text import fold, plain

TASK = "lineup"
PROMPT_VERSION = 3
BATCH = 12
PARALLEL = 4  # concurrent requests; Workers AI allows 300 per minute
KINDS = ["concert", "festival", "club", "tribute", "not_music"]
DESCRIPTION_CHARS = 600
MAX_SUPPORT = 12

SYSTEM = """You read Dutch and English music venue listings and say who is performing.

For each listing, return:
- kind:
  - "concert": one or more live acts play (bands, singers, musicians, ensembles, live
    electronic acts). These are concerts too: a band or live act playing dance music,
    techno or rave (e.g. a brass band at a rave, a "rave-act" at a dance event), even
    when the venue calls the evening a club night ("clubavond"); a music night with a
    talk, reading, book, film or Q&A alongside the band; and a named artist in a series
    or on a stage with a series name (e.g. "Open Stage: <artist>", "Discover: <artist>").
  - "festival": a multi-act day or series with a line-up, also when it has talks,
    films or workshops alongside the music.
  - "club": a DJ night or dance party: the only performers are DJs, or none are named.
  - "tribute": a tribute act or show devoted to another artist, e.g. "A Tribute to
    Queen", "The Music of ABBA", or a band named after the artist it imitates. A band
    with its own name and identity that plays covers or reinterprets other music (e.g.
    Nouvelle Vague, Postmodern Jukebox) is a "concert", not a tribute.
  - "not_music": no band or musician plays a set: a talk, film, workshop, masterclass,
    exhibition, guided tour, podcast, comedy, quiz, bingo, karaoke or singalong, or a
    jam session, open stage or open mic where anyone can join in. If a named band or
    musician plays, it is never "not_music".
- headliners: the main act or acts, exactly as spelled in the listing.
- support: supporting acts, exactly as spelled. For festivals, put the line-up here
  (at most 12 acts, as listed).

Performers are the people and groups who play, sing or DJ at the event, one act per
entry ("A + B" is two acts). Only use names that appear in the listing. Leave out
everyone and everything else:
- promoters, organisers, labels, collectives and venues. In "X presents: A + B",
  "X & Y present:", "X presenteert:" and "in collaboration with X", X organises and
  is not a performer (but an artist who "presents a new album" is performing).
- speakers, hosts, authors and film makers
- the name of the festival, series, night or event ("KRONKEL", "Tuesday Jam", "Popronde")
- titles of tours, albums, films, books, talks and shows
- genres, and words like "support", "guests", "friends", "DJ set".
If no performer is named, return empty lists."""

SCHEMA = {
    "type": "object",
    "properties": {
        "listings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "kind": {"type": "string", "enum": KINDS},
                    "headliners": {"type": "array", "items": {"type": "string"}},
                    "support": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["id", "kind", "headliners", "support"],
            },
        }
    },
    "required": ["listings"],
}

_LINEUP_HEADING = re.compile(
    r"\bline[- ]?up\s*(?::|\n|includes?\b|features?\b|bestaat uit\b|met\b|with\b)", re.I
)  # "LINE-UP: Deli Girls", "The lineup includes BeaBop", not "a line-up connecting"


def excerpt(description: str) -> str:
    """The start of a description, plus its line-up when that comes later: festivals
    often name their acts only after a few paragraphs."""
    head = description[:DESCRIPTION_CHARS]
    later = _LINEUP_HEADING.search(description, DESCRIPTION_CHARS - 20)
    if later is None:
        return head
    return f"{head} … {description[later.start() : later.start() + DESCRIPTION_CHARS]}"


def listing(gig: dict[str, Any]) -> dict[str, Any]:
    """The parts of a gig the model sees. Also the cache identity of its answer."""
    description = excerpt(gig.get("description") or "")
    return {
        k: v
        for k, v in {
            "id": gig["id"],
            "title": gig["title"],
            "subtitle": gig.get("subtitle"),
            "performers": gig.get("performers") or None,
            "support": gig.get("support") or None,
            "type": ", ".join(gig.get("categories") or []) or None,
            "genres": ", ".join(gig.get("genres") or []) or None,
            "description": description or None,
        }.items()
        if v
    }


# --- checks on the model's answer ---------------------------------------------------
# They run on cached answers too, so tightening one needs no new prompt version.


_TAGS = {"id", "type", "genres"}  # the venue's labels, not where performers are named


def texts(item: dict[str, Any]) -> list[str]:
    """The listing's own words: title, subtitle, performers, support, description."""
    out: list[Any] = []
    for key, value in item.items():
        if key not in _TAGS:
            out.extend(value if isinstance(value, list) else [value])
    return [str(t) for t in out if t]


def grounded(names: list[Any], item: dict[str, Any]) -> list[str]:
    """Keep only names that appear in the listing text, without repeats."""
    haystack = plain(" | ".join(texts(item)))
    kept, seen = [], set()
    for name in names:
        words = plain(name) if isinstance(name, str) else ""
        if words and words in haystack and words not in seen:
            seen.add(words)
            kept.append(name.strip())
    return kept


# How the listing mentions a name, by what comes after it and before it (lower case,
# no accents). Presenters: "X presents:", "X, Y & Z present", "X presenteert", "X & Y team
# up to present", "presented by X", but not "X presents their new album".
_PRESENTS_AFTER = re.compile(
    r"[?!'\"’”]*(?:\s*(?:,|&|\+|/|\band\b|\ben\b)[^.!?:;|()\n]{0,60}?)?"
    r"\s+(?:proudly\s+|(?:are\s+)?team(?:ing)?\s+up\s+to\s+)?present(?:s|eert|eren)?\b"
    r"(?!\s+(?:(?:hij|zij|ze|we|wij|hun|zijn|haar|his|her|their|its|the|het|de|an?|een)\s+)?"
    r"(?:new|nieuw\w*|debut\w*|latest|album|ep|single|plaat)\b)"
)
_PRESENTS_BEFORE = re.compile(
    r"\b(?:presented\s+by|gepresenteerd\s+door)\s+"
    r"(?:[^.!?:;|()\n]{0,60}?(?:,|&|\+|/|\band|\ben)\s+)?$"
)
# Beside the music: "X (book)", "Y (film)", "Z (q/a)", "book: X", "talk with X".
_ASIDE_AFTER = re.compile(
    r"\s*\((?:book|boek|film|movie|docu\w*|screening|talk|lezing|reading|q\s*[&/]?\s*a|"
    r"expo\w*|exhibition|workshop)\)"
)
_ASIDE_BEFORE = re.compile(
    r"\b(?:(?:book|boek|film|movie|screening|talk|lezing|reading)\s*:|"
    r"(?:talk|lezing|gesprek|interview|q\s*[&/]\s*a)\s+(?:with|met))\s*$"
)
# Playing: "X (solo set)", "Y (live)", "band: Z".
_PLAYS_AFTER = re.compile(r"\s*\((?:(?:solo|live|full\s+band)\s+)?(?:set|live|band|concert)\)")
_PLAYS_BEFORE = re.compile(r"\b(?:band|live|live\s+music|muziek|music|concert)\s*:\s*$")


def mentions(name: str, texts: list[str]) -> list[str]:
    """What each mention of `name` in the listing says it does: "presents", "aside"
    (a book, film or talk), "plays", or "" when it doesn't say."""
    words = plain(name).split()
    if not words:
        return []
    pattern = re.compile(
        r"(?<![a-z0-9])" + r"[^a-z0-9]+".join(map(re.escape, words)) + r"(?![a-z0-9])"
    )
    roles = []
    for text in texts:
        folded = fold(text)
        for m in pattern.finditer(folded):
            before = folded[: m.start()]
            if _PRESENTS_AFTER.match(folded, m.end()) or _PRESENTS_BEFORE.search(before):
                roles.append("presents")
            elif _ASIDE_AFTER.match(folded, m.end()) or _ASIDE_BEFORE.search(before):
                roles.append("aside")
            elif _PLAYS_AFTER.match(folded, m.end()) or _PLAYS_BEFORE.search(before):
                roles.append("plays")
            else:
                roles.append("")
    return roles


def not_playing(name: str, texts: list[str]) -> bool:
    """Whether every mention of `name` presents the event, or is a book, film or talk
    beside it, rather than playing: Pretty Ugly in "Geregeld Ontregeld, Pretty Ugly &
    Bandgurl666 present: KRONKEL", "THE BATTLE OF PARKHOF (BOOK)"."""
    roles = mentions(name, texts)
    return bool(roles) and all(r in ("presents", "aside") for r in roles)


_TAIL = re.compile(r"\s+[•·]\s.*$")  # "Blanks • Haarlem Vinyl Festival": the act first
_NOTE = re.compile(r"\s*\([^()]*\)$")  # "MINDWAR (BE)", "Colin Newman (Wire)"
_EVENT = re.compile(r"\bfest(?:ival)?s?\b|\bsessions?\b|\b20[2-3]\d\b", re.I)  # "Popronde 2026"
_FILLER = {"support", "supports", "guest", "guests", "special guest", "special guests",
           "friends", "and friends", "tba", "e a", "and more", "dj set", "live"}  # fmt: skip


def tidy(name: str) -> str:
    """A name without a trailing event after "•" or a note in brackets: MusicBrainz
    doesn't know "MINDWAR (BE)"."""
    name = _TAIL.sub("", name.strip())
    bare = _NOTE.sub("", name).strip()
    return bare if plain(bare) else name  # "СОЮЗ (SOYUZ)" keeps its Latin spelling


def performers(names: list[Any], item: dict[str, Any], words: list[str]) -> list[str]:
    """The model's names that are acts playing this listing: tidied, grounded in the
    listing (`words` is its `texts`), and no event names, presenters or filler words."""
    tidied = [tidy(n) for n in names if isinstance(n, str)]
    return [
        name
        for name in grounded(tidied, item)
        if not _EVENT.search(name) and plain(name) not in _FILLER and not not_playing(name, words)
    ]


def checked(row: dict[str, Any], item: dict[str, Any]) -> dict[str, Any]:
    """The model's answer for one listing (with a valid kind), as a line-up. A listing
    that says one of its acts plays ("band: Wanda's", "BHAJAN BHOY (Solo Set)") is music,
    even with a film, book or talk beside it."""
    words = texts(item)
    headliners = performers(row.get("headliners") or [], item, words)
    heads = {plain(n) for n in headliners}
    support = performers(row.get("support") or [], item, words)
    support = [n for n in support if plain(n) not in heads][:MAX_SUPPORT]
    kind = row["kind"]
    if kind == "not_music" and any("plays" in mentions(n, words) for n in headliners + support):
        kind = "concert"
    return {"kind": kind, "headliners": headliners, "support": support}


def misplaced(row: dict[str, Any], item: dict[str, Any]) -> bool:
    """Whether the model named acts, none of them in this listing: its answer was
    probably meant for another listing in the batch, kind and all."""
    names = [tidy(n) for n in row["headliners"] + row["support"] if n.strip()]
    return bool(names) and not grounded(names, item)


def by_rules(gig: dict[str, Any]) -> dict[str, Any]:
    names = names_from_text(gig["title"])
    support = [n for s in gig.get("support") or [] for n in names_from_text(s)]
    return {"kind": "concert", "headliners": names[:3], "support": support, "source": "rules"}


def parse_lineups(
    gigs: list[dict[str, Any]], llm: LLM | None, cache: Cache
) -> dict[str, dict[str, Any]]:
    """Line-up per gig id. Cached answers are reused; new listings go to the model in
    batches, as many as its budget allows (`llm.remaining`); everything else uses the
    title rules."""
    items = {g["id"]: listing(g) for g in gigs}
    result: dict[str, dict[str, Any]] = {}
    todo = []
    for gig in gigs:
        hit = cached_answer(cache, TASK, llm, PROMPT_VERSION, items[gig["id"]])
        if hit is not None:
            answer, model = hit
            result[gig["id"]] = {**checked(answer, items[gig["id"]]), "source": model}
        else:
            todo.append(gig["id"])

    batches = [todo[i : i + BATCH] for i in range(0, len(todo), BATCH)]
    batches = batches[: llm.remaining(TASK)] if llm is not None else []
    if gigs:
        print(
            f"lineup: {len(gigs) - len(todo)} cached, {len(todo)} to ask about "
            f"in {len(batches)} requests",
            file=sys.stderr,
        )
    model = MODELS[TASK] if llm is not None and llm.name != "fake" else "fake"

    def ask(batch: list[str]) -> tuple[list[str], dict[str, Any] | None, LLMError | None]:
        user = json.dumps([items[gid] for gid in batch], ensure_ascii=False)
        try:
            answer = llm.json(TASK, SYSTEM, user, SCHEMA)
            rows = {r.get("id"): r for r in answer["listings"] if isinstance(r, dict)}
            return batch, rows, None
        except LLMError as exc:
            return batch, None, exc

    # Requests run in parallel; the cache (SQLite) is only written from this thread.
    # Listings left unanswered (missing, invalid or misplaced) are asked again next run.
    started = time.monotonic()
    failed = unanswered = 0
    quota_noted = False
    with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
        for done, (batch, rows, error) in enumerate(pool.map(ask, batches), 1):
            if rows is None:
                failed += 1
                if not isinstance(error, QuotaExhausted) or not quota_noted:
                    print(f"lineup: batch failed, using title rules: {error}", file=sys.stderr)
                quota_noted = quota_noted or isinstance(error, QuotaExhausted)
            else:
                for gid in batch:
                    row = rows.get(gid)
                    if row is None or row.get("kind") not in KINDS:
                        unanswered += 1
                        continue
                    raw = {
                        "kind": row["kind"],
                        "headliners": _strings(row.get("headliners")),
                        "support": _strings(row.get("support")),
                    }
                    if misplaced(raw, items[gid]):
                        unanswered += 1
                        continue
                    store_answer(cache, TASK, llm, PROMPT_VERSION, items[gid], raw)
                    result[gid] = {**checked(raw, items[gid]), "source": model}
            if done % 10 == 0 or done == len(batches):
                elapsed = time.monotonic() - started
                print(
                    f"lineup: {done}/{len(batches)} batches, {failed} failed, "
                    f"{unanswered} listings unanswered, {elapsed:.0f}s",
                    file=sys.stderr,
                )

    for gig in gigs:  # not cached, so the model gets another go on the next run
        result.setdefault(gig["id"], by_rules(gig))
    return result


def _strings(value: Any) -> list[str]:
    return [v for v in value if isinstance(v, str)][:40] if isinstance(value, list) else []


def fake_answer(task: str, user: str) -> dict[str, Any]:
    """FakeLLM stand-in: the title rules, in the model's answer format."""
    listings = []
    for item in json.loads(user):
        names = names_from_text(item["title"])
        support = [n for s in item.get("support") or [] for n in names_from_text(s)]
        listings.append(
            {"id": item["id"], "kind": "concert", "headliners": names, "support": support}
        )
    return {"listings": listings}
