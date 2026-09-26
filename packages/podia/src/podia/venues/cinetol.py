"""Cinetol, Amsterdam. Reads the Webflow programme page, then each event's detail page.

The programme lists every event on one page. Its cards carry Finsweet list hooks
(`fs-list-field="name|support|genre"`) for the title, a subtitle line and up to a few
genre tags, plus the day, month and year and an UITVERKOCHT marker. Times, room, price
and the ticket link only appear on the detail page, so those are fetched too; without
`max_pages` that is one request per event (~70, about a minute at the default delay).
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from datetime import date

from selectolax.parser import HTMLParser, Node

from podia.extract import clean, combine, infer_year, parse_price
from podia.http import Fetcher
from podia.model import Availability, Event, Price, VenueInfo
from podia.venue import FetchOptions, Venue, register

BASE = "https://www.cinetol.nl"
PROGRAMME = f"{BASE}/programma"
# Detail pages fetched per unit of `max_pages`; the programme itself is a single page.
DETAILS_PER_PAGE = 5
# "support: løu", "album release + support: stuzzy pink", "supports: eigen risico + feral"
_SUPPORT = re.compile(r"\bsupports?:\s*(.+)$", re.IGNORECASE)


@register
class Cinetol(Venue):
    info = VenueInfo(slug="cinetol", name="Cinetol", city="Amsterdam", website=BASE)

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        r = fetch.get(PROGRAMME)
        r.raise_for_status()
        budget = None if options.max_pages is None else options.max_pages * DETAILS_PER_PAGE
        for item in HTMLParser(r.text).css('[fs-list-element="list"] > [role="listitem"]'):
            event = self._card(item, options.since)
            if event is None:
                continue
            if event.url and (budget is None or budget > 0):
                if budget is not None:
                    budget -= 1
                detail = fetch.get(event.url)
                if detail.status < 400:
                    _add_detail(event, HTMLParser(detail.text))
            yield event

    def _card(self, item: Node, since: date) -> Event | None:
        title = _text(item.css_first('[fs-list-field="name"]'))
        link = item.css_first('a[href^="/events/"]')
        day = _day(item, since)
        if not title or link is None or day is None:
            return None
        href = link.attributes["href"] or ""
        subtitle = _text(item.css_first('[fs-list-field="support"]'))
        support = _SUPPORT.search(subtitle or "")
        image = item.css_first(".card_image_wrapper img")
        sold_out = item.css_first(".sold-out") is not None
        return Event(
            venue=self.info.slug,
            source_id=href.rsplit("/", 1)[-1],
            title=title,
            start=combine(day, None),
            url=BASE + href,
            subtitle=subtitle,
            city=self.info.city,
            support=[s.strip() for s in support[1].split(" + ")] if support else [],
            genres=[t for n in item.css('[fs-list-field="genre"]') if (t := _text(n))],
            availability=Availability.SOLD_OUT if sold_out else Availability.UNKNOWN,
            image=image.attributes.get("src") if image is not None else None,
            extra={"just_added": True} if item.css_first('[fs-list-field="new"]') else {},
        )

    def redact(self, url: str, text: str) -> str:
        """Keep only the event list (programme) or the event info section (detail page),
        without the responsive-image `srcset` lists that make up most of the bytes."""
        tree = HTMLParser(text)
        selector = '[fs-list-element="list"]' if url == PROGRAMME else "section.section_eventinfo"
        node = tree.css_first(selector)
        if node is None:
            return text
        for img in node.css("img[srcset]"):
            del img.attrs["srcset"]
        return node.html or text


def _text(node: Node | None) -> str | None:
    return clean(node.text()) if node is not None else None


def _day(item: Node, since: date) -> date | None:
    """The card shows "Sat 26 . 09" plus hidden filter tags "Sep" and "2026"."""
    parts = [_text(n) for n in item.css(".card_location .event_date-flex .card_text")]
    numbers = [int(p) for p in parts if p and p.isdigit()]
    if len(numbers) != 2:
        return None
    day, month = numbers
    years = [int(t) for n in item.css(".event-tag.filter") if (t := _text(n)) and t.isdigit()]
    if years:
        return date(years[0], month, day)
    return infer_year(month, day, since)


def _add_detail(event: Event, tree: HTMLParser) -> None:
    """Room, doors and show time, prices, ticket link and description from a detail page.

    Webflow renders unused conditional blocks with `w-condition-invisible`; they are
    dropped first so a hidden "UITVERKOCHT" or TicketSwap link is not read as real.
    """
    for hidden in tree.css(".w-condition-invisible"):
        hidden.decompose()
    info = tree.css_first(".section_event-date-ticket-wrapper")
    if info is None:
        return
    day = event.start.date()
    prices: list[str] = []
    for row in info.css(".section_event-door-wrapper"):
        cells = [t for n in row.iter() if (t := _text(n))]
        if not cells:
            continue
        label = cells[0].rstrip(":").strip().lower()
        if label == "location":
            rooms = [t for n in row.css('[role="listitem"]') if (t := _text(n))]
            event.room = ", ".join(rooms) or None
        elif label == "doors" and len(cells) > 1:
            event.doors = combine(day, cells[1])
        elif label == "show" and len(cells) > 1:
            event.start = combine(day, cells[1])
        elif len(cells) > 1:  # "ticket", "ticket vanaf", "doorsale"…
            prices.append(f"{cells[0]} {' '.join(cells[1:])}")
    if prices:
        event.price = _price(prices)
        if event.price and event.price.min_eur == 0 and event.price.max_eur == 0:
            event.availability = Availability.FREE
    if info.css_first(".sold-out") is not None:
        event.availability = Availability.SOLD_OUT
    elif event.availability is Availability.UNKNOWN and event.price is not None:
        event.availability = Availability.ON_SALE
    button = info.css_first("a.button.ticket")
    href = button.attributes.get("href") if button is not None else None
    if href and href.startswith("http"):
        event.ticket_url = href
    body = tree.css_first('[fs-richtext-element="rich-text"]')
    event.description = clean(body.text(separator=" ")) if body is not None else None


def _price(rows: list[str]) -> Price | None:
    """Join "TICKET: € 11.75" and "DOORSALE: € 13.75" rows into one price range."""
    text = "; ".join(rows)
    parsed = [p for row in rows if (p := parse_price(row.split(":", 1)[-1]))]
    amounts = [a for p in parsed for a in (p.min_eur, p.max_eur) if a is not None]
    if not amounts:
        return Price(text=text)
    return Price(min(amounts), max(amounts), text)
