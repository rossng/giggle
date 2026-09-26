"""Tolhuistuin, Amsterdam. Reads the agenda data the site embeds for its Vue filter component.

`/agenda` carries every upcoming item in `<agenda-filter-component :all-items='[…]'>`, as
HTML-escaped JSON: title, start/end, type (Muziek, Talk, Kunst…), room, prices, sold-out
and free flags, ticket link and a short teaser. There are no genres or images.

The prop also serialises whole Craft CMS query objects, including the site's database
connection settings. Only the whitelisted fields in `FIELDS` are ever read, and `redact`
rebuilds the fixture from those fields alone, so nothing else from the prop is stored.

Concerts that Paradiso programmes here carry `paradisoEvent`; they also appear in the
Paradiso feed (as "Tolhuistuin"), so they are kept and marked `extra["paradiso"]`.
"""

from __future__ import annotations

import html
import json
import re
from collections import Counter
from collections.abc import Iterator
from datetime import datetime
from typing import Any

from podia.extract import clean, local, parse_price
from podia.http import Fetcher
from podia.model import Availability, Event, Price, VenueInfo
from podia.venue import FetchOptions, Venue, register

AGENDA = "https://www.tolhuistuin.nl/agenda"

_PROP = re.compile(r"<agenda-filter-component\b[^>]*?:all-items='([^']*)'")

# The only item fields read or stored. Everything else in the prop is dropped unseen.
FIELDS = (
    "uid",
    "title",
    "eventStartDate",
    "eventEndDate",
    "location",
    "freeEvent",
    "soldOut",
    "ticketPrice",
    "ticketSpecialPrice",
    "ticketLink",
    "url",
    "description",
    "paradisoEvent",
)

# Rooms that aren't in the building.
ELSEWHERE = {"Externe locatie"}


@register
class Tolhuistuin(Venue):
    info = VenueInfo(
        slug="tolhuistuin",
        name="Tolhuistuin",
        city="Amsterdam",
        website="https://www.tolhuistuin.nl",
    )

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        r = fetch.get(AGENDA)
        r.raise_for_status()
        items = [i for i in _items(r.text) if i["location"] not in ELSEWHERE]
        # A recurring event lists every date under the same uid; those get a date suffix.
        repeats = Counter(i["uid"] for i in items)
        for item in sorted(items, key=lambda i: i["eventStartDate"]):
            start = _time(item["eventStartDate"])
            source_id = item["uid"]
            if repeats[source_id] > 1:
                source_id += f"@{start:%Y%m%dT%H%M}"
            end = _time(item["eventEndDate"])
            price = _price(item)
            yield Event(
                venue=self.info.slug,
                source_id=source_id,
                title=clean(item["title"]) or "",
                start=start,
                end=end if end and end > start else None,
                url=item["url"],
                room=clean(item["location"]),
                city=self.info.city,
                categories=[item["eventType"]["label"]] if item["eventType"]["label"] else [],
                availability=_availability(item),
                price=price,
                ticket_url=item["ticketLink"] or None,
                description=clean(item["description"]),
                extra={"paradiso": True} if item["paradisoEvent"] else {},
            )

    def redact(self, url: str, text: str) -> str:
        # Rebuild the page from whitelisted fields only; never keep the raw prop.
        items = json.dumps(_items(text), ensure_ascii=False)
        tag = "agenda-filter-component"
        return f"<{tag} :all-items='{html.escape(items)}'></{tag}>\n"


def _items(page: str) -> list[dict[str, Any]]:
    """The agenda items, reduced to `FIELDS` plus the event type's label, in the page's shape."""
    m = _PROP.search(page)
    if m is None:
        raise LookupError("tolhuistuin: agenda data not found")
    items = []
    for raw in json.loads(html.unescape(m[1])):
        item = {name: raw.get(name) for name in FIELDS}
        item["eventType"] = {"label": (raw.get("eventType") or {}).get("label")}
        items.append(item)
    return items


def _time(value: str | None) -> datetime | None:
    # "2026/11/19 20:00:00", local time
    return local(datetime.strptime(value, "%Y/%m/%d %H:%M:%S")) if value else None


def _price(item: dict[str, Any]) -> Price | None:
    # `ticketSpecialPrice` holds the full wording when there are several tiers.
    if special := clean(item["ticketSpecialPrice"]):
        return parse_price(special)
    value = item["ticketPrice"]
    if isinstance(value, int | float) and (value > 0 or item["freeEvent"]):
        return Price(float(value), float(value))
    if isinstance(value, str):
        return parse_price(value)
    return Price(0.0, 0.0) if item["freeEvent"] else None


def _availability(item: dict[str, Any]) -> Availability:
    if item["soldOut"]:
        return Availability.SOLD_OUT
    if item["freeEvent"]:
        return Availability.FREE
    return Availability.UNKNOWN
