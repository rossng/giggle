"""Melkweg, Amsterdam. Reads the `__NEXT_DATA__` of the agenda page, which holds every
upcoming event in one go, and, through `details()`, each event's own page data.

Each listed event has its name, subtitle, start (and sometimes end), genre ids with a
lookup table, free-form tags, profile ids (Concert, Clubnacht, Film…), sold-out,
cancelled and moved flags, an image and a free-text `artists` line.

The listed time is the one the event page shows in its header, and it is not always the
same kind of time: for concerts it is the doors (MAX 19:00, Oude Zaal 19:30; the page's
timetable then says e.g. "19:00 Doors / 20:00 Polyphonic Orchestra"), for films usually
the screening itself ("21:00 Doors / 21:15 <film>"), for club nights the opening. The
listing can't tell these apart, so `start` is the listed time as is and `doors` stays
empty; `details()` sets both when the venue has published a timetable.

`details()` reads the Next.js data route `/_next/data/<buildId>/nl/agenda/<slug>.json`
(the build id comes from the agenda read; the page's own `__NEXT_DATA__` is the fallback
when it is unknown or stale). It adds the room(s), ticket prices and link, the intro as
description, the minimum age and, from the timetable (usually published only in the last
weeks before the event), the doors time and the first programme item as `start`.
"""

from __future__ import annotations

import copy
import json
import re
from collections.abc import Iterator
from datetime import datetime, time, timedelta
from typing import Any
from urllib.parse import urlsplit

from podia.extract import clean, next_data, parse_iso, parse_price, strip_tags
from podia.http import Fetcher
from podia.model import AMSTERDAM, Availability, Event, Price, Status, VenueInfo
from podia.venue import FetchOptions, Venue, register

BASE = "https://www.melkweg.nl"
AGENDA = f"{BASE}/nl/agenda/"

# The `artists` line only names support acts when it says so: "Support: A / B".
_SUPPORT = re.compile(r"^\s*supports?\s*:\s*(.+)$", re.I | re.S)
# Room codes as the event pages print them; other codes ("MAX", "CINEMA"…) are kept.
_ROOMS = {"OZ": "Oude Zaal", "UP": "Upstairs", "RABO": "Rabozaal"}
# Timetable lines: "19:00 Doors", "20:30 mike.", "18:15 VIP Doors", "21:00 End".
_SLOT = re.compile(r"^\s*(\d{1,2})[:.](\d{2})\s+(.+?)\s*$")
_DOORS = re.compile(r"^(doors|deuren|deuren open|zaal open)$", re.I)
_END = {"end", "einde", "eind", "curfew"}
_NOT_SHOW = re.compile(r"\b(vip|m&g|meet\s*&\s*greet|pauze|break|doors|deuren)\b", re.I)


@register
class Melkweg(Venue):
    info = VenueInfo(
        slug="melkweg", name="Melkweg", city="Amsterdam", website="https://www.melkweg.nl"
    )
    has_details = True
    # Next.js build id from the last agenda read, for the lighter per-event data route.
    _build_id: str | None = None

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        r = fetch.get(AGENDA)
        r.raise_for_status()
        data = next_data(r.text)
        if data is None:
            raise ValueError("melkweg: agenda page has no __NEXT_DATA__")
        self._build_id = data.get("buildId")
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

    def details(self, fetch: Fetcher, event: Event) -> Event:
        page = self._event_page(fetch, event)
        if page is None:
            return event
        return _with_details(event, page.get("attributes", {}).get("metadata") or {})

    def _event_page(self, fetch: Fetcher, event: Event) -> dict[str, Any] | None:
        """The event's `pageData`: from the data route (about half the bytes of the page)
        when the agenda gave a build id, else from the page's `__NEXT_DATA__`."""
        if not event.url:
            return None
        if self._build_id:
            path = urlsplit(event.url).path.rstrip("/")
            r = fetch.get(f"{BASE}/_next/data/{self._build_id}{path}.json")
            if r.status < 400:
                return r.json()["pageProps"]["pageData"]
            self._build_id = None  # redeployed since the agenda was read; use the pages
        r = fetch.get(event.url)
        r.raise_for_status()
        data = next_data(r.text)
        if data is None:
            raise ValueError(f"melkweg: {event.url} has no __NEXT_DATA__")
        return data["props"]["pageProps"]["pageData"]

    def redact(self, url: str, text: str) -> str:
        if "/_next/data/" in url:  # an event's data route: its metadata is enough
            page = json.loads(text)["pageProps"]["pageData"]
            payload = {"pageProps": {"pageData": _trim_event_page(page)}}
            return json.dumps(payload, ensure_ascii=False, indent=1) + "\n"
        data = next_data(text)
        if data is None:
            return text
        props = data["props"]["pageProps"]
        if url == AGENDA:  # the build id, the genre table and the agenda block
            page = {"genres": props.get("genres", []), "pageData": {"attributes": {"content": [
                {"layout": "agenda", "attributes": _agenda(props)}
            ]}}}  # fmt: skip
        else:  # an event page
            page = {"pageData": _trim_event_page(props["pageData"])}
        payload = json.dumps(
            {"buildId": data.get("buildId"), "props": {"pageProps": page}}, ensure_ascii=False
        )
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


def _trim_event_page(page: dict[str, Any]) -> dict[str, Any]:
    """An event's `pageData` without its content blocks (which repeat the metadata and
    embed the related events), for fixtures."""
    attributes = page.get("attributes", {})
    return {
        "id": page.get("id"),
        "attributes": {k: attributes[k] for k in ("title", "url", "metadata") if k in attributes},
    }


def _with_details(event: Event, m: dict[str, Any]) -> Event:
    e = copy.deepcopy(event)
    rooms = [_ROOMS.get(code, code) for loc in m.get("locations") or [] if (code := clean(loc))]
    if rooms:
        e.room = ", ".join(rooms)
    tiers = _tiers(m.get("ticketPrices"))
    if price := _price(tiers):
        e.price = price
    if any(t.get("membership_required") for t in _headline(tiers)):
        e.extra["membership_required"] = True
    if link := clean(m.get("ticketLink")):
        e.ticket_url = link
    if description := strip_tags(m.get("intro")):
        e.description = description
    if age := clean(m.get("leeftijdsgrens")):
        e.extra["age"] = age
    if slots := _timetable(e.start, m.get("timeschedule")):
        _apply_timetable(e, slots)
    return e


def _tiers(prices: Any) -> list[dict[str, Any]]:
    """The ticket tiers the page shows ("ticket1"…"ticket6", most of them hidden)."""
    if not isinstance(prices, dict):
        return []
    return [t for t in prices.values() if isinstance(t, dict) and t.get("show") and t.get("price")]


def _headline(tiers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The tiers marked primary (the regular ticket, not a VIP package or the Cineville
    €0), else those not sold out."""
    return (
        [t for t in tiers if t.get("primary")]
        or [t for t in tiers if "sold out" not in (t.get("label") or "").lower()]
        or tiers
    )


def _price(tiers: list[dict[str, Any]]) -> Price | None:
    """A range over the headline tiers; `text` lists every tier shown, e.g.
    "regular € 23; VIP Package € 105"."""
    if not tiers:
        return None
    labelled = (clean(f"{t.get('label') or ''} {t['price']}") for t in tiers)
    text = "; ".join(t for t in labelled if t)
    parsed = [p for t in _headline(tiers) if (p := parse_price(t["price"]))]
    amounts = [a for p in parsed for a in (p.min_eur, p.max_eur) if a is not None]
    if not amounts:
        return Price(text=text)
    return Price(min(amounts), max(amounts), text)


def _timetable(start: datetime, text: str | None) -> list[tuple[datetime, str]]:
    """The timetable ("19:00 Doors\\r\\n20:00 Polyphonic Orchestra") as dated slots on the
    listed day. A time earlier than the one before it (or long before the listed time) is
    past midnight."""
    slots: list[tuple[datetime, str]] = []
    for line in (text or "").splitlines():
        m = _SLOT.match(line)
        if not m or int(m[1]) > 23 or int(m[2]) > 59:
            continue
        at = datetime.combine(start.date(), time(int(m[1]), int(m[2])), AMSTERDAM)
        previous = slots[-1][0] if slots else start - timedelta(hours=6)
        if at < previous:
            at += timedelta(days=1)
        slots.append((at, clean(m[3]) or ""))
    return slots


def _apply_timetable(e: Event, slots: list[tuple[datetime, str]]) -> None:
    """Doors from the "Doors" line; the start is the first programme line after it (not a
    VIP entrance, break or end); an "End" line fills a missing end."""
    doors = next((at for at, label in slots if _DOORS.match(label)), None)
    end = next((at for at, label in slots if label.lower() in _END), None)
    show = next(
        (
            at
            for at, label in slots
            if (doors is None or at >= doors)
            and label.lower() not in _END
            and not _NOT_SHOW.search(label)
        ),
        None,
    )
    if doors is not None:
        e.doors = doors
    if show is not None:
        e.start = show
    if end is not None and e.end is None and end > e.start:
        e.end = end
    e.extra["timetable"] = [f"{at:%H:%M} {label}" for at, label in slots]
