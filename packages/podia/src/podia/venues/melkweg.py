"""Melkweg, Amsterdam. Reads the `__NEXT_DATA__` of the agenda page, which holds every
upcoming event in one go.

Each event has its name, subtitle, start (and sometimes end), genre ids with a lookup
table, free-form tags, profile ids (Concert, Clubnacht, Film…), sold-out, cancelled and
moved flags, an image and a free-text `artists` line. Room, price, ticket link and
description are only on the individual event pages, which this adapter does not fetch.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from typing import Any

from podia.extract import clean, next_data, parse_iso
from podia.http import Fetcher
from podia.model import Availability, Event, Status, VenueInfo
from podia.venue import FetchOptions, Venue, register

BASE = "https://www.melkweg.nl"
AGENDA = f"{BASE}/nl/agenda/"

# The `artists` line only names support acts when it says so: "Support: A / B".
_SUPPORT = re.compile(r"^\s*supports?\s*:\s*(.+)$", re.I | re.S)


@register
class Melkweg(Venue):
    info = VenueInfo(
        slug="melkweg", name="Melkweg", city="Amsterdam", website="https://www.melkweg.nl"
    )

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        r = fetch.get(AGENDA)
        r.raise_for_status()
        data = next_data(r.text)
        if data is None:
            raise ValueError("melkweg: agenda page has no __NEXT_DATA__")
        props = data["props"]["pageProps"]
        genre_names = {g["id"]: g["attributes"]["name"]["nl"] for g in props.get("genres", [])}
        agenda = _agenda(props)
        profiles = agenda.get("profilesObject") or {}
        for item in agenda.get("initialEvents") or []:
            a = item["attributes"]
            start = parse_iso(a.get("startDate"))
            if start is None:
                continue
            end = parse_iso(a.get("endDate"))
            artists = clean(a.get("artists"))
            support = _support(artists)
            extra: dict[str, Any] = {}
            if artists and not support:
                extra["lineup"] = artists
            if a.get("movedTo"):
                extra["moved_to"] = parse_iso(a["movedTo"]).isoformat()
            yield Event(
                venue=self.info.slug,
                source_id=item["id"],
                title=clean(a.get("name")) or "",
                subtitle=clean(a.get("subtitle")),
                start=start,
                end=end if end and end > start else None,
                url=_url(a.get("url")),
                city=self.info.city,
                support=support,
                genres=_genres(a, genre_names),
                categories=[
                    profiles[p["id"]]
                    for p in item.get("relationships", {}).get("profiles", {}).get("data", [])
                    if p.get("id") in profiles
                ],
                status=_status(a),
                availability=Availability.SOLD_OUT if a.get("isSoldOut") else Availability.UNKNOWN,
                image=next(
                    (i["filename"] for i in a.get("media", {}).get("featuredImage") or []), None
                ),
                extra=extra,
            )

    def redact(self, url: str, text: str) -> str:
        # Keep only the genre table and the agenda block of `__NEXT_DATA__`.
        data = next_data(text)
        if data is None:
            return text
        props = data["props"]["pageProps"]
        page = {"genres": props.get("genres", []), "pageData": {"attributes": {"content": [
            {"layout": "agenda", "attributes": _agenda(props)}
        ]}}}  # fmt: skip
        payload = json.dumps({"props": {"pageProps": page}}, ensure_ascii=False)
        payload = payload.replace("</", "<\\/")
        return f'<script id="__NEXT_DATA__" type="application/json">{payload}</script>\n'


def _agenda(props: dict[str, Any]) -> dict[str, Any]:
    for block in props["pageData"]["attributes"]["content"]:
        if block.get("layout") == "agenda":
            return block["attributes"]
    raise ValueError("melkweg: no agenda block in page data")


def _url(path: str | None) -> str | None:
    if not path:
        return None
    # Event pages live at the path with a trailing slash; without it they redirect.
    return BASE + path.rstrip("/") + "/"


def _genres(a: dict[str, Any], names: dict[str, str]) -> list[str]:
    """The broad genres from the lookup table, then the finer tags, without repeats."""
    out: list[str] = []
    for value in [names.get(g) for g in a.get("genres") or []] + (a.get("tags") or []):
        value = clean(value)
        if value and value.lower() not in {v.lower() for v in out}:
            out.append(value)
    return out


def _support(artists: str | None) -> list[str]:
    m = _SUPPORT.match(artists or "")
    if not m:
        return []
    return [name for part in m[1].split(" / ") if (name := clean(part))]


def _status(a: dict[str, Any]) -> Status:
    if a.get("isCancelled") or a.get("status") == "Afgelast":
        return Status.CANCELLED
    if a.get("isMovedToNewDate") or a.get("status") == "Verplaatst":
        return Status.POSTPONED
    return Status.SCHEDULED
