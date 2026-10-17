"""OT301, Amsterdam (Overtoom 301). Reads the agenda's JSON from Amsterdam Alternative and,
through `details()`, each event's page on ot301.nl.

ot301.nl's agenda page fills itself from Amsterdam Alternative's event service
(`amsterdamalternative.nl/services/get-events-past-v25.php`, venue 105), the listing
shared by Amsterdam's squats and former squats. One request with `months=12` returns
every upcoming event in the building: start (a Unix timestamp), room ("-Studios",
"-Café Gilde", "-Ventilator Cinema"…, with a leading dash), the type ("Concert",
"Electronic music, party", "Film", "Food, kitchen"…, kept as the category), title, a
comma-separated line-up, the price as typed ("8-12", "Free", "Donation") and a poster
id. Events with `aa_presale` sell tickets through Amsterdam Alternative.

`details()` reads the event page for what the listing lacks: the genre line ("Post-punk,
noise, indie-rock"), the closing time ("Open: 20:00 - 01:00 hrs") and the description.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import replace
from datetime import datetime, timedelta
from typing import Any

from selectolax.parser import HTMLParser

from podia.extract import clean, combine, mask_emails, node_text, parse_price, site_url
from podia.http import Fetcher
from podia.model import AMSTERDAM, Availability, Event, Price, VenueInfo
from podia.venue import FetchOptions, Venue, register

BASE = "https://ot301.nl"
AA = "https://amsterdamalternative.nl"
EVENTS = f"{AA}/services/get-events-past-v25.php"
VENUE_ID = 105
_NUMBER = re.compile(r"\d+(?:[.,]\d{1,2})?")
# "Line up: TBA", "t.b.a.": no names yet.
_TBA = re.compile(r"^(?:t\.?b\.?a\.?|tbc|tba)$", re.I)
_OPEN = re.compile(r"(\d{1,2}[:.]\d{2})\s*-\s*(\d{1,2}[:.]\d{2})")
_EVENT_PAGE = re.compile(r'<div class="selected event">.*?</article>\s*</div>', re.S)


@register
class Ot301(Venue):
    info = VenueInfo(slug="ot301", name="OT301", city="Amsterdam", website=BASE)
    has_details = True

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        params = {"venue": VENUE_ID, "month": options.since.month, "months": 12, "image": "true"}
        r = fetch.get(EVENTS, params=params)
        r.raise_for_status()
        for item in r.json().get("items") or []:
            event = self._item(item)
            if event is not None and event.start.date() >= options.since:
                yield event

    def _item(self, item: dict[str, Any]) -> Event | None:
        if not item.get("id") or not item.get("start"):
            return None
        source_id = str(item["id"])
        price = _price(item.get("price"))
        presale = bool(item.get("aa_presale"))
        kind = (item.get("type") or {}).get("label")
        header = item.get("header") or {}
        return Event(
            venue=self.info.slug,
            source_id=source_id,
            title=clean(item.get("title")) or "",
            start=datetime.fromtimestamp(int(item["start"]), tz=AMSTERDAM),
            url=site_url(BASE, f"/agenda/{source_id}"),
            room=clean((item.get("venue_room") or "").lstrip("-")),
            city=self.info.city,
            performers=_lineup(item.get("lineup")),
            categories=[c for c in (clean(kind),) if c],
            availability=_availability(price, presale),
            price=price,
            ticket_url=f"{AA}/tickets/{source_id}" if presale else None,
            image=f"{AA}/media/content/{int(header['id'])}_large.jpg"
            if str(header.get("id") or "").isdigit()
            else None,
        )

    def details(self, fetch: Fetcher, event: Event) -> Event:
        if not event.url:
            return event
        r = fetch.get(event.url)
        r.raise_for_status()
        page = HTMLParser(r.text).css_first(".selected.event")
        if page is None:
            return event
        fields = _fields(page.css_first(".detail"))
        changes: dict[str, Any] = {}
        if not event.genres and (genre := fields.get("genre")):
            changes["genres"] = [g for g in (clean(s) for s in genre.split(",")) if g]
        if not event.performers and (lineup := _lineup(fields.get("line up"))):
            changes["performers"] = lineup
        if event.end is None and (m := _OPEN.search(fields.get("open") or "")):
            end = combine(event.start.date(), m[2])
            changes["end"] = end + timedelta(days=1) if end <= event.start else end
        if not event.description and (text := node_text(page.css_first(".text"))):
            changes["description"] = text
        return replace(event, **changes) if changes else event

    def redact(self, url: str, text: str) -> str:
        # Event pages: only the event itself, without the site's scripts, menus and footer.
        if url.startswith(f"{BASE}/agenda/") and (m := _EVENT_PAGE.search(text)):
            text = m[0]
        return mask_emails(text)


def _fields(detail: Any) -> dict[str, str]:
    """The event page's "<strong>Genre:</strong> Post-punk<br/>…" lines, by lower-case label."""
    if detail is None:
        return {}
    fields: dict[str, str] = {}
    for line in re.split(r"<br\s*/?>", detail.html or ""):
        text = clean(HTMLParser(line).text(separator=" ")) or ""
        label, sep, value = text.partition(":")
        if sep and value.strip():
            fields[label.strip().lower()] = value.strip()
    return fields


def _lineup(value: str | None) -> list[str]:
    names = (clean(s) for s in (value or "").split(","))
    return [n for n in names if n and not _TBA.match(n)]


def _price(value: str | None) -> Price | None:
    text = clean(value)
    if not text:
        return None
    if _NUMBER.fullmatch(text):
        amount = float(text.replace(",", "."))
        return Price(amount, amount, None)
    return parse_price(text)


def _availability(price: Price | None, presale: bool) -> Availability:
    if price is not None and price.max_eur == 0:
        return Availability.FREE
    return Availability.ON_SALE if presale else Availability.UNKNOWN
