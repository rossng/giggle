"""Het Zonnehuis, Amsterdam-Noord. Reads the agenda page and, through `details()`, each
event's own page.

The agenda (`zonnehuis.amsterdam/agenda/`, one page) lists every upcoming event with
its date (`<time datetime>`), start time, title and a genre line ("Muziek", "Kinderen,
Muziek", "Rondleiding"…), kept as categories. Paradiso's shows here ("Paradiso
Presenteert: …") are listed too. The WordPress REST API is disallowed by robots.txt.

An event that runs on several days is listed once with a range ("za 10 t/m zo 11
oktober") and no time; for those the event page's play list (`table.speellijst`) is read
in `events()` and one event is yielded per performance, with the date in `source_id`.

`details()` reads the event page for the start time, price, door time ("Zaal open:
19:30 uur"), ticket link, the promoter's page and the description.
"""

from __future__ import annotations

import copy
import re
from collections.abc import Iterator
from datetime import date

from selectolax.parser import HTMLParser, Node

from podia.extract import (
    clean,
    combine,
    infer_year,
    mask_emails,
    month_number,
    node_text,
    parse_price,
)
from podia.http import Fetcher
from podia.model import Availability, Event, Price, VenueInfo
from podia.venue import FetchOptions, Venue, register

BASE = "https://zonnehuis.amsterdam"
AGENDA = f"{BASE}/agenda/"
# Event pages read per unit of `max_pages`; only needed for multi-day events.
DETAILS_PER_PAGE = 3
_CLOCK = re.compile(r"\d{1,2}[:.]\d{2}")
_ROW_DATE = re.compile(r"(\d{1,2})\s+([a-z]+)", re.I)


@register
class Zonnehuis(Venue):
    info = VenueInfo(slug="zonnehuis", name="Het Zonnehuis", city="Amsterdam", website=BASE)
    has_details = True

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        r = fetch.get(AGENDA)
        r.raise_for_status()
        budget = None if options.max_pages is None else options.max_pages * DETAILS_PER_PAGE
        for link in HTMLParser(r.text).css("[data-component-event-list] a[href]"):
            event = self._item(link)
            if event is None:
                continue
            if event.start is not _RANGE:
                if event.start.date() >= options.since:
                    yield event
                continue
            # A run over several days: one event per performance, from the event page.
            if budget is not None:
                if budget <= 0:
                    continue
                budget -= 1
            page = fetch.get(event.url or "")
            if page.status >= 400:
                continue
            tree = HTMLParser(page.text)
            for day, clock in _performances(tree, options.since):
                if day < options.since:
                    continue
                e = copy.deepcopy(event)
                e.source_id = f"{event.source_id}-{day.isoformat()}"
                e.start = combine(day, clock)
                e.extra = {} if clock else {"time_known": False}
                _add_detail(e, tree)
                yield e

    def details(self, fetch: Fetcher, event: Event) -> Event:
        if not event.url:
            return event
        r = fetch.get(event.url)
        r.raise_for_status()
        e = copy.deepcopy(event)
        _add_detail(e, HTMLParser(r.text))
        return e

    def _item(self, link: Node) -> Event | None:
        href = link.attributes.get("href") or ""
        card = link.css_first(".event")
        title = node_text(link.css_first("h2"))
        m = re.search(r"/voorstelling/[^/]+/(\d+)/?$", href)
        if card is None or not title or not m:
            return None
        when = link.css_first(".times time[datetime]")
        clock = node_text(link.css(".times time")[-1]) if link.css(".times time") else None
        has_time = bool(clock and _CLOCK.search(clock))
        if when is not None:
            start = combine(
                date.fromisoformat(when.attributes["datetime"] or ""), clock if has_time else None
            )
        else:
            start = _RANGE  # "za 10 t/m zo 11 oktober"
        genre = node_text(link.css_first(".genre"))
        image = link.css_first(".img-container img")
        return Event(
            venue=self.info.slug,
            source_id=m[1],
            title=title,
            start=start,
            url=href,
            city=self.info.city,
            categories=[c.strip() for c in (genre or "").split(",") if c.strip()],
            image=image.attributes.get("src") if image is not None else None,
            extra={} if has_time else {"time_known": False},
        )

    def redact(self, url: str, text: str) -> str:
        """Agenda: only the event list. Event page: only the event detail block."""
        tree = HTMLParser(text)
        selector = (
            "[data-component-event-list]" if url == AGENDA else "[data-component-event-detail]"
        )
        node = tree.css_first(selector)
        return mask_emails(node.html or text if node is not None else text)


# Placeholder start for multi-day listings; replaced per performance before yielding.
_RANGE = combine(date(1970, 1, 1), None)


def _performances(tree: HTMLParser, since: date) -> list[tuple[date, str | None]]:
    """(day, "20:30") per row of the play list: `<td class="date">za 10 okt</td>`."""
    rows = []
    for row in tree.css("table.speellijst tr"):
        m = _ROW_DATE.search(node_text(row.css_first("td.date")) or "")
        if not m:
            continue
        try:
            day = infer_year(month_number(m[2]), int(m[1]), since)
        except KeyError:
            continue
        clock = node_text(row.css_first("td.time"))
        if day is not None:
            rows.append((day, clock if clock and _CLOCK.search(clock) else None))
    return rows


def _price(text: str | None) -> Price | None:
    """The "Toegangsprijs" line, e.g. "€ 26,20 incl servicekosten", "€5,- entree (excl.
    €1,- servicekosten)", "€ 7,50 volwassenen gratis voor kinderen", "Gratis entree".
    A fee in brackets isn't a ticket price; "gratis" next to an amount makes the lowest
    price 0."""
    text = clean(text)
    if not text:
        return None
    amounts_only = re.sub(r"\([^)]*kosten[^)]*\)", " ", text)
    amounts_only = re.sub(r"\b(gratis|free)\b", " ", amounts_only, flags=re.I)
    price = parse_price(amounts_only)
    if price is None or price.min_eur is None:
        return (
            parse_price(text) if re.search(r"\b(gratis|free)\b", text, re.I) else Price(text=text)
        )
    low = 0.0 if re.search(r"\b(gratis|free)\b", text, re.I) else price.min_eur
    return Price(low, price.max_eur, text)


def _add_detail(event: Event, tree: HTMLParser) -> None:
    """Start time, price, doors, ticket link, promoter page and description from an
    event page, into `event` (a copy of the listed one)."""
    detail = tree.css_first("[data-component-event-detail]")
    if detail is None:
        return
    info: dict[str, Node] = {}
    for item in detail.css("ul.event-info li"):
        label = node_text(item.css_first("h4"))
        if label:
            info[label.lower()] = item
    clock = node_text(info["tijd"].css_first("p")) if "tijd" in info else None
    if clock and (m := _CLOCK.search(clock)) and event.extra.get("time_known") is False:
        event.start = combine(event.start.date(), m[0])
        event.extra["time_known"] = True
    if "toegangsprijs" in info and (
        price := _price(node_text(info["toegangsprijs"].css_first("p")))
    ):
        event.price = price
    more = node_text(info["meer info"].css_first("p")) if "meer info" in info else None
    if more and (
        m := re.search(r"(?:zaal|deur(?:en)?)\s+open\s*:?\s*(\d{1,2}[:.]\d{2})", more, re.I)
    ):
        doors = combine(event.start.date(), m[1])
        if doors <= event.start and event.extra.get("time_known", True):
            event.doors = doors
    if "website" in info and (a := info["website"].css_first("a[href]")):
        href = a.attributes.get("href") or ""
        if href.startswith("http"):
            event.extra["website"] = href
    button = next(
        (
            a
            for a in detail.css("ul.event-info a.button[href]")
            if "kaart" in (node_text(a) or "").lower()
        ),
        None,
    )
    href = button.attributes.get("href") if button is not None else None
    if href and href.startswith("http"):
        event.ticket_url = href
    text = " ".join(t for n in detail.css(".excerpt, .main-content") if (t := node_text(n)))
    if description := clean(text):
        event.description = description
    status = (node_text(detail.css_first("table.speellijst")) or "").lower()
    if "uitverkocht" in status:
        event.availability = Availability.SOLD_OUT
    elif event.price is not None and event.price.max_eur == 0:
        event.availability = Availability.FREE
    elif event.ticket_url:
        event.availability = Availability.ON_SALE
