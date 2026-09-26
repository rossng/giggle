"""Who is actually playing: the line-up of each gig, read from its listing by an LLM.

Venue titles mix artist names with tour names, festival names, series labels and
notes ("Discover: Ronker + Grote Geelstaart", "KRONKEL FESTIVAL" with the line-up in
the description). The model returns headliners and support acts per gig, plus what
kind of event it is. Names it returns must appear in the listing text, so it can't
invent artists. Where the model fails, the title rules in `artists` stand in.
"""

from __future__ import annotations

import json
import sys
import unicodedata
from typing import Any

from giggle_pipeline.artists import names_from_text
from giggle_pipeline.cache import Cache, key_for
from giggle_pipeline.llm import LLM, MODELS, LLMError

PROMPT_VERSION = 1
BATCH = 12
KINDS = ["concert", "festival", "club", "tribute", "not_music"]

SYSTEM = """You read Dutch and English music venue listings and say who is performing.

For each listing, return:
- kind: "concert" (one or a few acts), "festival" (a multi-act day or series with a
  line-up), "club" (DJ or dance night), "tribute" (tribute or cover act, or a show
  playing another artist's music), or "not_music" (talk, film, workshop, exhibition,
  rehearsal, jam session, open stage, quiz…).
- headliners: the main act or acts, exactly as spelled in the listing.
- support: supporting acts, exactly as spelled. For festivals, put the line-up here
  (at most 12 acts, as listed).

Only use names that appear in the listing. Leave out tour names, album titles,
festival and series names, venue names, and words like "support", "guests", "DJ set".
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


def listing(gig: dict[str, Any]) -> dict[str, Any]:
    """The parts of a gig the model sees. Also the cache identity of its answer."""
    description = (gig.get("description") or "")[:600]
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


def _plain(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return " ".join("".join(c if c.isalnum() else " " for c in text).split())


def grounded(names: list[Any], item: dict[str, Any]) -> list[str]:
    """Keep only names that appear in the listing text, without repeats."""
    haystack = _plain(json.dumps(item, ensure_ascii=False))
    kept, seen = [], set()
    for name in names:
        plain = _plain(name) if isinstance(name, str) else ""
        if plain and plain in haystack and plain not in seen:
            seen.add(plain)
            kept.append(name.strip())
    return kept


def by_rules(gig: dict[str, Any]) -> dict[str, Any]:
    names = names_from_text(gig["title"])
    support = [n for s in gig.get("support") or [] for n in names_from_text(s)]
    return {"kind": "concert", "headliners": names[:3], "support": support, "source": "rules"}


def parse_lineups(
    gigs: list[dict[str, Any]], llm: LLM | None, cache: Cache, max_calls: int = 200
) -> dict[str, dict[str, Any]]:
    """Line-up per gig id. Cached answers are reused; new listings go to the model in
    batches, up to `max_calls` requests; everything else uses the title rules."""
    model = MODELS["lineup"] if llm and llm.name != "fake" else "fake"
    items = {g["id"]: listing(g) for g in gigs}
    keys = {gid: key_for(PROMPT_VERSION, model, item) for gid, item in items.items()}
    result: dict[str, dict[str, Any]] = {}
    todo = []
    for gig in gigs:
        cached = cache.get("lineup", keys[gig["id"]])
        if cached is not None:
            result[gig["id"]] = cached
        else:
            todo.append(gig["id"])

    calls = 0
    for start in range(0, len(todo), BATCH):
        if llm is None or calls >= max_calls:
            break
        batch = todo[start : start + BATCH]
        calls += 1
        user = json.dumps([items[gid] for gid in batch], ensure_ascii=False)
        try:
            answer = llm.json("lineup", SYSTEM, user, SCHEMA)
            rows = {r.get("id"): r for r in answer.get("listings", []) if isinstance(r, dict)}
        except (LLMError, AttributeError) as exc:
            print(f"lineup: batch failed, using title rules: {exc}", file=sys.stderr)
            continue
        for gid in batch:
            row = rows.get(gid)
            if row is None or row.get("kind") not in KINDS:
                continue
            parsed = {
                "kind": row["kind"],
                "headliners": grounded(row.get("headliners") or [], items[gid]),
                "support": grounded(row.get("support") or [], items[gid])[:12],
                "source": model,
            }
            cache.put("lineup", keys[gid], parsed)
            result[gid] = parsed

    for gig in gigs:  # not cached, so the model gets another go on the next run
        result.setdefault(gig["id"], by_rules(gig))
    return result


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
