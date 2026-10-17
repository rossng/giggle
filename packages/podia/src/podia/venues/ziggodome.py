"""Ziggo Dome, Amsterdam-Zuidoost. Reads the JSON API behind the Next.js site.

The agenda page loads its list from `/api/agenda/aankomend/` (upcoming shows, 50 a
page, `limit`/`offset` with a `pagination.hasMore` flag): one record per show with the
performer, the tour name (`event.title`), the show time, sale state and ticket link,
genres (a JSON string), a description, the support acts and image file names.

`showDate` is UTC (the site converts it to Amsterdam time to show it) and is the show's
start; with `showTimeUnknown` only its day counts. A "Rescheduled" show has its new date
here, so it stays scheduled (`extra["rescheduled"]`). The support acts are a rich-text
field with each act's name in bold, sometimes with a role in front ("Special guest |
Architects", "Opener | WASEEL"). Images are file names under the site's asset CDN; the
API's signed blob-storage links to the same files are dropped from fixtures.

`details()` reads `/api/agenda/events/<id>/`, which adds the running order (door time,
start, expected end, as clock times on the show's day) and a ticket price.

Capacity: 17,550 standing in the main hall, as the site's business pages ("Zakelijk")
give it (12,950 seated).
"""

from __future__ import annotations

import dataclasses
import json
import re
from collections.abc import Iterator
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from urllib.parse import quote

from podia.extract import clean, combine, mask_emails, site_url, strip_tags
from podia.http import Fetcher
from podia.model import AMSTERDAM, Availability, Event, Price, Status, VenueInfo
from podia.venue import FetchOptions, Venue, register

BASE = "https://www.ziggodome.nl"
AGENDA = f"{BASE}/api/agenda/aankomend/"
DETAILS = f"{BASE}/api/agenda/events/"
IMAGES = "https://cdn.ziggodome.nl/assets/"
PAGE_SIZE = 50

_STATUS = {
    "Canceled": Status.CANCELLED,
    "Postponed": Status.POSTPONED,
}
_AVAILABILITY = {"OnSale": Availability.ON_SALE, "SoldOut": Availability.SOLD_OUT}
_STRONG = re.compile(r"<strong>(.*?)</strong>", re.S)
_CLOCK = re.compile(r"^\d{1,2}[:.]\d{2}$")
# Fields the adapter reads, for trimming fixtures.
_LISTING_KEYS = (
    "id", "showDate", "showTimeUnknown", "showState", "salesUrl", "salesStartDate",
    "performerName", "event", "genres", "description", "supportActDescription",
    "artistImage", "backgroundImage", "privateEvent", "visible",
)  # fmt: skip


@register
class ZiggoDome(Venue):
    info = VenueInfo(
        slug="ziggodome", name="Ziggo Dome", city="Amsterdam", website=BASE, capacity=17550
    )
    has_details = True

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        events = []
        offset, pages = 0, 0
        while options.max_pages is None or pages < options.max_pages:
            r = fetch.get(AGENDA, params={"limit": PAGE_SIZE, "offset": offset})
            r.raise_for_status()
            page = r.json()
            pages += 1
            for item in page.get("data") or []:
                event = self._event(item, options.since)
                if event is not None and event.start.date() >= options.since:
                    events.append(event)
            pagination = page.get("pagination") or {}
            if not pagination.get("hasMore"):
                break
            offset += PAGE_SIZE
        yield from sorted(events, key=lambda e: (e.start, e.source_id))

    def _event(self, item: dict[str, Any], since: date) -> Event | None:
        if item.get("privateEvent") or not item.get("visible", 1):
            return None
        start = _utc(item.get("showDate"))
        title = clean(item.get("performerName"))
        if start is None or not title or not item.get("id"):
            return None
        extra: dict[str, Any] = {}
        if item.get("showTimeUnknown"):
            start = datetime.combine(start.date(), time(0, 0), AMSTERDAM)
            extra["time_known"] = False
        tour = item.get("event") if isinstance(item.get("event"), dict) else {}
        if youtube := (tour.get("youtubeUrl") or "").strip():
            extra["youtube"] = youtube
        state = item.get("showState") or ""
        if state == "Rescheduled":  # moved to the date given here
            extra["rescheduled"] = True
        ticket_url = (item.get("salesUrl") or "").strip()
        return Event(
            venue=self.info.slug,
            source_id=item["id"],
            title=title,
            start=start,
            url=site_url(BASE, f"/events/{quote(item['id'])}/"),
            subtitle=clean(tour.get("title")),
            city=self.info.city,
            support=_support(item.get("supportActDescription")),
            genres=_genres(item.get("genres")),
            status=_STATUS.get(state, Status.SCHEDULED),
            availability=_availability(state, _utc(item.get("salesStartDate")), since),
            ticket_url=ticket_url if ticket_url.startswith(("https://", "http://")) else None,
            description=strip_tags(item.get("description")),
            image=_image(item.get("artistImage")) or _image(item.get("backgroundImage")),
            extra=extra,
        )

    def details(self, fetch: Fetcher, event: Event) -> Event:
        r = fetch.get(f"{DETAILS}{quote(event.source_id)}/")
        r.raise_for_status()
        data = r.json()
        show = next(iter(data.get("data") or []), {})
        times = _program(data.get("program"))
        changes: dict[str, Any] = {}
        start = event.start
        if event.extra.get("time_known") is False and "start" in times:
            start = combine(event.start.date(), times["start"])
            changes["start"] = start
            changes["extra"] = event.extra | {"time_known": True}
        if event.doors is None and "doors" in times:
            doors = combine(start.date(), times["doors"])
            if doors <= start:
                changes["doors"] = doors
        if event.end is None and "end" in times:
            end = combine(start.date(), times["end"])
            if end <= start:  # "00:00": after midnight
                end += timedelta(days=1)
            if end < start + timedelta(hours=12):
                changes["end"] = end
        if event.price is None and (price := _price(show)) is not None:
            changes["price"] = price
        return dataclasses.replace(event, **changes) if changes else event

    def redact(self, url: str, text: str) -> str:
        """Only the fields read here; no signed storage links, no email addresses."""
        data = json.loads(text)
        if url == AGENDA:
            items = [_trim(item) for item in data.get("data") or []]
            data = {"data": items, "pagination": data.get("pagination")}
        else:
            show = next(iter(data.get("data") or []), {})
            keep = ("id", "minTicketPrice", "maxTicketPrice")
            data = {
                "data": [{k: show.get(k) for k in keep}],
                "program": data.get("program"),
            }
        return mask_emails(json.dumps(data, ensure_ascii=False, indent=1))


def _trim(item: dict[str, Any]) -> dict[str, Any]:
    item = {k: item.get(k) for k in _LISTING_KEYS}
    for key in ("artistImage", "backgroundImage"):
        if isinstance(item[key], dict):
            item[key] = {"assetFileName": item[key].get("assetFileName")}
    if isinstance(item["event"], dict):
        item["event"] = {k: item["event"].get(k) for k in ("title", "youtubeUrl")}
    return item


def _utc(value: str | None) -> datetime | None:
    """ "2026-10-18 18:00:00", in UTC, as Amsterdam time."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(AMSTERDAM)


def _support(fragment: str | None) -> list[str]:
    """Bold names in the support field, without a role in front ("Opener | WASEEL")."""
    acts = []
    for bold in _STRONG.findall(fragment or ""):
        name = clean((strip_tags(bold) or "").rsplit("|", 1)[-1])
        if name and name not in acts:
            acts.append(name)
    return acts


def _genres(value: Any) -> list[str]:
    """`[{"name": "Pop", "name_en": "Pop"}]`, as a JSON string; the Dutch names."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return []
    names = []
    for genre in value or []:
        if isinstance(genre, dict) and (name := clean(genre.get("name"))) and name not in names:
            names.append(name)
    return names


def _availability(state: str, sales_start: datetime | None, since: date) -> Availability:
    if state in ("OnSale", "NoTickets") and sales_start and sales_start.date() > since:
        return Availability.NOT_YET
    return _AVAILABILITY.get(state, Availability.UNKNOWN)


def _image(asset: Any) -> str | None:
    name = asset.get("assetFileName") if isinstance(asset, dict) else None
    if not name or not isinstance(name, str):
        return None
    return IMAGES + quote(name.lstrip("/"))


def _program(program: Any) -> dict[str, str]:
    """Door time, start and expected end from the running order, as "HH:MM"."""
    found: dict[str, str] = {}
    for block in program or []:
        for row in (block or {}).get("program") or []:
            clock = (row.get("time") or "").strip()
            label = (row.get("title_en") or row.get("title") or "").strip().lower()
            if not _CLOCK.match(clock):
                continue
            if label.startswith("doors"):
                found.setdefault("doors", clock)
            elif label.startswith("start show"):
                found.setdefault("start", clock)
            elif label.startswith("expected end"):
                found.setdefault("end", clock)
    return found


def _price(show: dict[str, Any]) -> Price | None:
    def amount(value: Any) -> float | None:
        try:
            return float(value) if value not in (None, "") else None
        except (TypeError, ValueError):
            return None

    low, high = amount(show.get("minTicketPrice")), amount(show.get("maxTicketPrice"))
    if low is None and high is None:
        return None
    return Price(low if low is not None else high, high if high is not None else low)
