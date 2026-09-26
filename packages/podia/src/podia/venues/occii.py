"""OCCII, Amsterdam. Reads the public iCal feed from its WordPress Events Manager plugin.

The feed has title, times, description, a category (music, party, bar/cafe…), the event
URL and a price. It has no genres or sold-out status; those only appear in the HTML.
"""

from __future__ import annotations

from collections.abc import Iterator

import icalendar

from podia.extract import clean, local, parse_price
from podia.http import Fetcher
from podia.model import Availability, Event, Price, VenueInfo
from podia.venue import FetchOptions, Venue, register

FEED = "https://occii.org/events.ics"


@register
class Occii(Venue):
    info = VenueInfo(slug="occii", name="OCCII", city="Amsterdam", website="https://occii.org")

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        r = fetch.get(FEED)
        r.raise_for_status()
        calendar = icalendar.Calendar.from_ical(r.text)
        for item in calendar.walk("VEVENT"):
            start = item.decoded("DTSTART")
            end = item.decoded("DTEND") if "DTEND" in item else None
            cost = item.get("X-RDR-COST")
            price = _price(str(cost)) if cost is not None else None
            yield Event(
                venue=self.info.slug,
                source_id=str(item.get("UID")),
                title=clean(str(item.get("SUMMARY"))) or "",
                start=local(start),
                end=local(end) if end else None,
                url=str(item.get("URL")) if item.get("URL") else None,
                city=self.info.city,
                categories=_categories(item),
                availability=_availability(price),
                price=price,
                description=clean(str(item.get("DESCRIPTION", ""))),
            )


def _categories(item: icalendar.Event) -> list[str]:
    value = item.get("CATEGORIES")
    if value is None:
        return []
    values = value if isinstance(value, list) else [value]
    return [str(c) for v in values for c in v.cats]


def _availability(price: Price | None) -> Availability:
    return Availability.FREE if price and price.min_eur == 0 else Availability.UNKNOWN


def _price(text: str) -> Price | None:
    if text.replace(".", "", 1).isdigit():
        amount = float(text)
        return Price(amount, amount, None)
    return parse_price(text)
