"""Podium Victorie, Alkmaar. Reads the programme page, the WordPress REST API for each
event's location, and, through `details()`, each event's own page.

The programme (`/programma/`, one page) lists every upcoming event as an
`article.event-line` with the post id (`data-id`), title, a subtitle, a poster and the
ticket button's state ("Tickets", "Laatste kaarten", "Uitverkocht", "Gratis").
`data-type` is the venue's own split into "live" and "dance" (club nights), sometimes
"dance-live" or empty; its parts are kept as categories.

The `<time datetime>` there is off: the venue's local time with Amsterdam's offset
added once more ("2026-10-21T21:50:00+02:00" for a show starting at 19:50, "…T00:00+01:00"
on the 28th for a club night at 23:00 on the 27th). Read in UTC it is the right wall-clock
time, which also matches the day shown next to it ("27 nov"); should the venue fix it,
the shown day is what tells the two apart. `details()` reads the real start ("Aanvang")
from the event page anyway.

The programme also lists "Victorie on Tour" shows in churches and theatres around
Alkmaar and festivals elsewhere. The REST API (`/wp-json/wp/v2/event`, no dates or
fields of its own) says where each event is, as a `venue-<slug>` class; only events in
Victorie's own rooms are kept (events the API doesn't know are kept too).

`details()` reads the event page for the start and door times ("Aanvang", "Deur open"),
the room ("Zaal"), ticket prices, the ticket link and the description.
"""

from __future__ import annotations

import copy
import re
from collections.abc import Iterator
from datetime import UTC, date, datetime

from selectolax.parser import HTMLParser, Node

from podia.extract import (
    clean,
    combine,
    mask_emails,
    month_number,
    node_text,
    parse_price,
    site_url,
)
from podia.http import Fetcher
from podia.model import AMSTERDAM, Availability, Event, Price, VenueInfo
from podia.venue import FetchOptions, Venue, register

BASE = "https://www.podiumvictorie.nl"
PROGRAMME = f"{BASE}/programma/"
EVENTS_API = f"{BASE}/wp-json/wp/v2/event"
PER_PAGE = 100
# Victorie's own rooms, as `venue-<slug>` classes in the REST API; anything else is a show
# elsewhere ("venue-kapelkerk-alkmaar", "venue-hal-25"…).
HOME_ROOMS = {"grolsch-zaal", "kleine-zaal", "gehele-pand"}
_CLOCK = re.compile(r"\d{1,2}[:.]\d{2}")
_SHOWN_DAY = re.compile(r"(\d{1,2})\s+([a-z]+)", re.I)
_DATE = re.compile(r"(\d{1,2})\s+([a-z]+)\s+(\d{4})", re.I)
_BUTTONS = {
    "tickets": Availability.ON_SALE,
    "laatste kaarten": Availability.FEW_LEFT,
    "uitverkocht": Availability.SOLD_OUT,
    "gratis": Availability.FREE,
}


@register
class Victorie(Venue):
    info = VenueInfo(slug="victorie", name="Podium Victorie", city="Alkmaar", website=BASE)
    has_details = True

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        r = fetch.get(PROGRAMME)
        r.raise_for_status()
        rooms = _rooms(fetch, options.max_pages)
        for article in HTMLParser(r.text).css("article.event-line"):
            event = self._item(article)
            if event is None or event.start.date() < options.since:
                continue
            room = rooms.get(event.source_id)
            if room is not None and not room & HOME_ROOMS:
                continue
            yield event

    def details(self, fetch: Fetcher, event: Event) -> Event:
        if not event.url:
            return event
        r = fetch.get(event.url)
        r.raise_for_status()
        e = copy.deepcopy(event)
        _add_detail(e, HTMLParser(r.text))
        return e

    def _item(self, article: Node) -> Event | None:
        post_id = article.attributes.get("data-id") or ""
        link = article.css_first("a[href]")
        title = node_text(article.css_first("h2"))
        when = article.css_first("time[datetime]")
        if not post_id.isdigit() or link is None or not title or when is None:
            return None
        start = _start(when.attributes.get("datetime") or "", node_text(when))
        if start is None:
            return None
        button = node_text(article.css_first("span.button[title]"))
        availability = _BUTTONS.get((button or "").lower(), Availability.UNKNOWN)
        kind = article.attributes.get("data-type") or ""
        return Event(
            venue=self.info.slug,
            source_id=post_id,
            title=title,
            start=start,
            url=site_url(BASE, link.attributes.get("href")),
            subtitle=node_text(article.css_first(".subtitles p")),
            city=self.info.city,
            categories=[part for part in kind.split("-") if part],
            availability=availability,
            price=parse_price(button) if availability is Availability.FREE else None,
            image=_largest(article.css_first("img[srcset]")),
        )

    def redact(self, url: str, text: str) -> str:
        """Programme: only the event list. Event page: only the block with the event's
        facts and text. The REST answer is kept as it is (ids and classes only)."""
        if url.startswith(EVENTS_API):
            return text
        tree = HTMLParser(text)
        if url == PROGRAMME:
            kept = "\n".join(a.html or "" for a in tree.css("article.event-line"))
        else:
            block = next((n for n in tree.css(".color-mask") if n.css_first("dt")), None)
            kept = block.html or "" if block is not None else text
        return mask_emails(kept)


def _rooms(fetch: Fetcher, max_pages: int | None) -> dict[str, set[str]]:
    """Post id → the `venue-<slug>` slugs the REST API gives it."""
    rooms: dict[str, set[str]] = {}
    page = 1
    while max_pages is None or page <= max_pages:
        r = fetch.get(
            EVENTS_API,
            params={"per_page": str(PER_PAGE), "page": str(page), "_fields": "id,class_list"},
        )
        if r.status == 400:  # past the last page
            break
        r.raise_for_status()
        items = r.json()
        for item in items:
            classes = item.get("class_list") or []
            rooms[str(item.get("id"))] = {
                c.removeprefix("venue-") for c in classes if c.startswith("venue-")
            }
        if len(items) < PER_PAGE:
            break
        page += 1
    return rooms


def _start(value: str, shown: str | None) -> datetime | None:
    """The real start from the programme's shifted `datetime` (see the module docstring)."""
    try:
        raw = datetime.fromisoformat(value)
    except ValueError:
        return None
    if raw.tzinfo is None:
        return None
    fixed = raw.astimezone(UTC).replace(tzinfo=AMSTERDAM)
    m = _SHOWN_DAY.search(shown or "")
    try:
        day = (int(m[1]), month_number(m[2])) if m else None
    except KeyError:
        day = None
    if day is not None and day != (fixed.day, fixed.month) and day == (raw.day, raw.month):
        return raw.astimezone(AMSTERDAM)  # the venue has fixed its times
    return fixed


def _largest(img: Node | None) -> str | None:
    """The widest picture in an `img`'s srcset."""
    if img is None:
        return None
    best, width = None, -1
    for part in (img.attributes.get("srcset") or "").split(","):
        bits = part.split()
        if len(bits) == 2 and re.fullmatch(r"\d+w", bits[1]) and int(bits[1][:-1]) > width:
            best, width = bits[0], int(bits[1][:-1])
    return best if best and best.startswith("https://") else None


def _add_detail(event: Event, tree: HTMLParser) -> None:
    """Start, doors, room, prices, ticket link and description from an event page, into
    `event` (a copy of the listed one)."""
    facts: dict[str, str] = {}
    prices: list[tuple[str, Price]] = []
    for dt in tree.css("dt"):
        label, dd = node_text(dt), dt.next
        while dd is not None and dd.tag != "dd":
            dd = dd.next
        value = node_text(dd)
        if not label or not value:
            continue
        facts[label.lower()] = value
        if "€" in value and (price := parse_price(value)) and price.min_eur is not None:
            prices.append((label, price))
    day = _date(facts.get("datum")) or event.start.date()
    if (clock := facts.get("aanvang")) and _CLOCK.search(clock):
        event.start = combine(day, clock)
    if (clock := facts.get("deur open")) and _CLOCK.search(clock):
        doors = combine(day, clock)
        if doors <= event.start:
            event.doors = doors
    if room := facts.get("zaal"):
        event.room = room
    if prices:
        amounts = [p.min_eur for _, p in prices if p.min_eur is not None]
        text = ", ".join(f"{label} {p.text}" for label, p in prices)
        event.price = Price(min(amounts), max(amounts), text)
    link = tree.css_first("a[data-active-tickets-link][href]")
    href = link.attributes.get("href") if link is not None else None
    if href and href.startswith("https://"):
        event.ticket_url = href
    text = " ".join(t for n in tree.css(".typogram") if (t := node_text(n)))
    if description := clean(text):
        event.description = description


def _date(text: str | None) -> date | None:
    """ "wo 21 oktober 2026" → that date."""
    m = _DATE.search(text or "")
    if not m:
        return None
    try:
        return date(int(m[3]), month_number(m[2]), int(m[1]))
    except (KeyError, ValueError):
        return None
