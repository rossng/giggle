"""EKKO, Utrecht. Reads the agenda page for the upcoming events, then the WordPress REST
API for their data.

The agenda page (`/agenda/`) lists every upcoming event, but only as a link, a title and
a filter label. The REST API (`/wp-json/wp/v2/event`) has everything else in the
event's ACF fields: start and end, doors, price and ticket link, support act, a one-line
description, related artists and the location. It keeps past events too and can't
filter by date, so the agenda's slugs are asked for in one call (`slug=a,b,…`), with
the category and genre names embedded (`_embed=wp:term`).

EKKO also books shows at other Utrecht venues (ACU, De Kromme Haring, De Nijverheid).
Only events at EKKO itself are yielded.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import datetime
from typing import Any

from selectolax.parser import HTMLParser

from podia.extract import clean, combine, local, strip_tags
from podia.http import Fetcher
from podia.model import Availability, Event, Price, Status, VenueInfo
from podia.venue import FetchOptions, Venue, register

BASE = "https://ekko.nl"
AGENDA = f"{BASE}/agenda/"
API = f"{BASE}/wp-json/wp/v2"
EVENTS = f"{API}/event"
LOCATIONS = f"{API}/location"
PAGE_SIZE = 50  # slugs per REST call; keeps the query string short
OWN_LOCATION = "EKKO"


@register
class Ekko(Venue):
    info = VenueInfo(slug="ekko", name="EKKO", city="Utrecht", website=BASE)

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        r = fetch.get(AGENDA)
        r.raise_for_status()
        slugs = _agenda_slugs(r.text)
        locations = _locations(fetch)
        items: list[dict[str, Any]] = []
        for page, i in enumerate(range(0, len(slugs), PAGE_SIZE)):
            if options.max_pages is not None and page >= options.max_pages:
                break
            params = {
                "slug": ",".join(slugs[i : i + PAGE_SIZE]),
                "lang": "nl",
                "per_page": "100",
                "_embed": "wp:term",
            }
            r = fetch.get(EVENTS, params=params)
            r.raise_for_status()
            items.extend(r.json())
        events = []
        for item in items:
            location = locations.get(item["acf"].get("location") or 0)
            if location not in (None, OWN_LOCATION):
                continue  # at another venue
            event = self._event(item)
            if event is not None and event.start.date() >= options.since:
                events.append(event)
        yield from sorted(events, key=lambda e: (e.start, e.source_id))

    def _event(self, item: dict[str, Any]) -> Event | None:
        acf = item["acf"]
        start = _datetime(acf.get("date_time"))
        title = clean(strip_tags(item["title"]["rendered"]))
        if start is None or not title:
            return None
        terms = [t for group in item.get("_embedded", {}).get("wp:term", []) for t in group]
        end = _datetime(acf.get("date_time_end"))
        doors = combine(start.date(), acf["time_open"]) if acf.get("time_open") else None
        extra: dict[str, Any] = {}
        if related := [
            a for a in (clean(x) for x in (acf.get("related_artists") or "").split(",")) if a
        ]:
            extra["related_artists"] = related
        if presenter := clean(acf.get("presented_by")):
            extra["presented_by"] = presenter
        if age := clean(str(acf.get("minimum_age") or "")):
            extra["minimum_age"] = age
        if series := [t["name"] for t in terms if t["taxonomy"] == "series"]:
            extra["series"] = series
        price = _price(acf.get("price"))
        button = (clean(acf.get("ticket_button_text")) or "").lower()
        return Event(
            venue=self.info.slug,
            source_id=item["slug"],
            title=title,
            start=start,
            url=item["link"],
            subtitle=clean(acf.get("one_liner")),
            doors=doors if doors and doors <= start else None,
            end=end if end and end > start else None,
            city=self.info.city,
            support=_support(acf.get("support_act")),
            genres=[clean(t["name"]) or "" for t in terms if t["taxonomy"] == "genre"],
            categories=[clean(t["name"]) or "" for t in terms if t["taxonomy"] == "category"],
            status=_status(button),
            availability=_availability(button, price, acf.get("ticket_link")),
            price=price,
            ticket_url=acf.get("ticket_link") or None,
            description=strip_tags(item["content"]["rendered"]),
            extra=extra,
        )

    def redact(self, url: str, text: str) -> str:
        """Agenda page: only the event links. REST responses: only the fields read here."""
        if url == AGENDA:
            links = HTMLParser(text).css("a.event-line-item[href]")
            return "\n".join(
                f'<a class="event-line-item" href="{a.attributes["href"]}"></a>' for a in links
            )
        if url == EVENTS:
            keep = ("slug", "link", "title", "content", "acf", "_embedded")
            items = [{k: item[k] for k in keep if k in item} for item in json.loads(text)]
            for item in items:
                item["acf"].pop("playlist_embed", None)
                for group in item.get("_embedded", {}).get("wp:term", []):
                    for term in group:
                        for k in list(term):
                            if k not in ("taxonomy", "name"):
                                del term[k]
            return json.dumps(items, ensure_ascii=False)
        return text


def _agenda_slugs(page: str) -> list[str]:
    slugs = []
    for a in HTMLParser(page).css("a.event-line-item[href]"):
        href = (a.attributes.get("href") or "").rstrip("/")
        if href.startswith(f"{BASE}/event/"):
            slugs.append(href.rsplit("/", 1)[-1])
    return list(dict.fromkeys(slugs))


def _locations(fetch: Fetcher) -> dict[int, str]:
    """Location post id → name, e.g. {56: "EKKO", 67: "ACU"}."""
    r = fetch.get(LOCATIONS, params={"per_page": "100", "_fields": "id,title"})
    r.raise_for_status()
    return {loc["id"]: clean(loc["title"]["rendered"]) or "" for loc in r.json()}


def _datetime(value: str | None) -> datetime | None:
    """ "2027-05-15 20:00:00", local time."""
    if not value:
        return None
    try:
        return local(datetime.fromisoformat(value))
    except ValueError:
        return None


def _support(value: str | None) -> list[str]:
    """ "Blue Lake" or "Blue Lake, Jonnine"."""
    text = clean(value) or ""
    return [s for s in (clean(p) for p in text.replace(" + ", ",").split(",")) if s]


def _price(amount: Any) -> Price | None:
    """ACF `price`: a number of euros (service fees included), or empty."""
    if amount in (None, "", False):
        return None
    try:
        value = float(amount)
    except (TypeError, ValueError):
        return Price(text=clean(str(amount)))
    return Price(value, value, None)


def _status(button: str) -> Status:
    """The ticket button's text doubles as the status: "GEANNULEERD", "AFGELAST"."""
    if "geannuleerd" in button or "afgelast" in button or "cancel" in button:
        return Status.CANCELLED
    if "verplaatst" in button or "postponed" in button:
        return Status.POSTPONED
    return Status.SCHEDULED


def _availability(button: str, price: Price | None, ticket_link: str | None) -> Availability:
    """From the ticket button ("UITVERKOCHT", "GEEN VVK", "Reserveer gratis ticket",
    "GRATIS", "Koop tickets"…), the price and whether there is a ticket link."""
    if "uitverkocht" in button or "sold out" in button:
        return Availability.SOLD_OUT
    if "gratis" in button or (price is not None and price.min_eur == 0):
        return Availability.FREE
    if "geen vvk" in button:  # no presale: tickets at the door only
        return Availability.UNKNOWN
    if ticket_link and _status(button) is Status.SCHEDULED:
        return Availability.ON_SALE
    return Availability.UNKNOWN
