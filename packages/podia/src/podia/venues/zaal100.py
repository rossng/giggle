"""Zaal 100, Amsterdam (De Wittenstraat 100): improvised music, jazz, singer-songwriters,
plus a restaurant and small theatre. Reads the homepage's agenda and, through
`details()`, each event's own page.

The site is WordPress, but its `event` post type isn't in the REST API and its RSS feed
(`/event/feed/`) has only titles, so the homepage is the source: one request lists every
upcoming event as an `article.agenda-item` with weekday, day and month, start time, price
and three title lines (`h4.voor-titel`, `h2.titel`, `h5.na-titel`). The link's `title`
attribute is the editors' internal name and starts with the full date ("20261020 Impro
Jazzcafé"), which gives the year; without it the year is inferred.

The site has no categories. Dinners are listed as "Restaurant: Yayang"; that prefix is
kept as the category "Restaurant", the venue's own word, so consumers can leave them out.
The upper title line is a series or presenter ("Elke dinsdag:", "Amsterdam Blues Company
presenteert:") and goes into `extra["pretitle"]`; the lower line, often the line-up, is the
subtitle. Exhibitions (`/expositie/`) aren't events and are skipped.

`details()` reads the event page for the description and the poster (the featured image,
outside `main`). On dinner-and-music nights the listed time is when the doors and kitchen
open; a page that says when the music begins ("De live muziek begint om 20.00 uur") moves
the start there and keeps the listed time as the doors.
"""

from __future__ import annotations

import copy
import re
from collections.abc import Iterator
from datetime import date

from selectolax.parser import HTMLParser, Node

from podia.extract import clean, combine, infer_year, mask_emails, node_text, parse_price, site_url
from podia.http import Fetcher
from podia.model import Availability, Event, VenueInfo
from podia.venue import FetchOptions, Venue, register

BASE = "https://zaal100.nl"
AGENDA = f"{BASE}/"
_CLOCK = re.compile(r"\d{1,2}[:.]\d{2}")
_DATED = re.compile(r"^(\d{4})(\d{2})(\d{2})\b")
_BEGINS = re.compile(
    r"\b(?:muziek|concert|voorstelling|optreden)\s+begint\s+om\s+(\d{1,2}[:.]\d{2})", re.I
)
_SLUG = re.compile(r"/event/([^/?#]+)/?$")


@register
class Zaal100(Venue):
    info = VenueInfo(slug="zaal100", name="Zaal 100", city="Amsterdam", website=BASE)
    has_details = True

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        r = fetch.get(AGENDA)
        r.raise_for_status()
        for item in HTMLParser(r.text).css(".agenda-container article.agenda-item"):
            event = self._item(item, options.since)
            if event is not None and event.start.date() >= options.since:
                yield event

    def details(self, fetch: Fetcher, event: Event) -> Event:
        if not event.url:
            return event
        r = fetch.get(event.url)
        r.raise_for_status()
        tree = HTMLParser(r.text)
        item = tree.css_first("article.agenda-item")
        if item is None:
            return event
        e = copy.deepcopy(event)
        text = node_text(item.css_first(".tekstblok"))
        if not e.description and text:
            e.description = text
        _music_start(e, text or "")
        image = tree.css_first(".featured-image img.wp-post-image")
        if not e.image and image is not None:
            src = image.attributes.get("src") or ""
            if src.startswith("http"):
                e.image = src
        return e

    def _item(self, item: Node, since: date) -> Event | None:
        link = item.css_first("a[href]")
        if link is None:
            return None
        href = site_url(BASE, link.attributes.get("href")) or ""
        m = _SLUG.search(href)
        title = node_text(item.css_first(".titel"))
        if not m or not title:
            return None
        day = _day(item, clean(link.attributes.get("title")) or "", since)
        if day is None:
            return None
        clock = node_text(item.css_first(".tijd"))
        has_time = bool(clock and _CLOCK.search(clock))
        price = parse_price(node_text(item.css_first(".prijs")))
        extra: dict[str, object] = {} if has_time else {"time_known": False}
        if pretitle := node_text(item.css_first(".voor-titel")):
            extra["pretitle"] = pretitle
        return Event(
            venue=self.info.slug,
            source_id=m[1],
            title=title,
            start=combine(day, clock if has_time else None),
            url=href,
            subtitle=node_text(item.css_first(".na-titel")),
            city=self.info.city,
            categories=["Restaurant"] if re.match(r"restaurant\s*:", title, re.I) else [],
            price=price,
            availability=(
                Availability.FREE
                if price is not None and price.max_eur == 0
                else Availability.UNKNOWN
            ),
            extra=extra,
        )

    def redact(self, url: str, text: str) -> str:
        """Homepage: only the agenda. Event page: only the event and its poster."""
        tree = HTMLParser(text)
        selectors = (
            [".agenda-container"]
            if url == AGENDA
            else ["main article.agenda-item", ".featured-image-container"]
        )
        nodes = [n for s in selectors if (n := tree.css_first(s)) is not None]
        if not nodes:
            return mask_emails(text)
        return mask_emails("\n".join(n.html or "" for n in nodes))


def _music_start(event: Event, text: str) -> None:
    """Dinner nights list the time the doors and kitchen open ("Zaal open 18.00 uur … De
    live muziek begint om 20.00 uur"); the page's later start for the music corrects the
    listing's, which becomes the door time."""
    m = _BEGINS.search(text)
    if not m or event.extra.get("time_known") is False:
        return
    start = combine(event.start.date(), m[1])
    if start > event.start:
        event.doors, event.start = event.start, start


def _day(item: Node, name: str, since: date) -> date | None:
    """The date from the day and month on the card, with the year from the link's
    "20261020 …" name when it agrees, else inferred."""
    try:
        day = int(node_text(item.css_first(".datum")) or "")
        month = int(node_text(item.css_first(".maand")) or "")
    except ValueError:
        return None
    if (m := _DATED.match(name)) and (int(m[2]), int(m[3])) == (month, day):
        try:
            return date(int(m[1]), month, day)
        except ValueError:
            pass
    try:
        return infer_year(month, day, since)
    except ValueError:
        return None
