"""Garage Noord, Amsterdam-Noord. Reads the club agenda page and, through `details()`,
each event's own page.

The site (Kirby CMS) has no feed, JSON-LD or public API (`/api` needs a login), so the
agenda page is read as HTML: `/club` lists every upcoming event in one request, each
with its day ("23"), month and year ("October, 2026"), title and weticket.io ticket
link. Garage Noord is a bar and night club and files everything under "club", so that
is every event's category; the occasional gig night (Amsterdam Punk Event) is in there
too. No times are published anywhere, so `start` is the day at 00:00 Amsterdam time
and `extra["time_known"]` stays False.

`details()` reads the event page for the description, the poster and the "Listen here"
links, whose names are the night's line-up (bands and DJs alike).
"""

from __future__ import annotations

import copy
from collections.abc import Iterator
from datetime import date

from selectolax.parser import HTMLParser, Node

from podia.extract import clean, combine, mask_emails, month_number, node_text, site_url
from podia.http import Fetcher
from podia.model import Event, VenueInfo
from podia.venue import FetchOptions, Venue, register

BASE = "https://garagenoord.com"
AGENDA = f"{BASE}/club"


@register
class GarageNoord(Venue):
    info = VenueInfo(slug="garagenoord", name="Garage Noord", city="Amsterdam", website=BASE)
    has_details = True

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        r = fetch.get(AGENDA)
        r.raise_for_status()
        for item in HTMLParser(r.text).css(".events > .event"):
            event = self._item(item)
            if event is not None and event.start.date() >= options.since:
                yield event

    def details(self, fetch: Fetcher, event: Event) -> Event:
        if not event.url:
            return event
        r = fetch.get(event.url)
        r.raise_for_status()
        page = HTMLParser(r.text).css_first(".single-content")
        if page is None:
            return event
        e = copy.deepcopy(event)
        text = [t for n in page.css(".single-content__blocks .block") if (t := node_text(n))]
        if text and not e.description:
            e.description = "\n\n".join(text)
        image = page.css_first(".single-content__image img")
        src = site_url(BASE, image.attributes.get("src")) if image is not None else None
        if src and not e.image:
            e.image = src
        names = [t for n in page.css(".single-content__links__link a") if (t := node_text(n))]
        if names and not e.performers:
            e.performers = names
        return e

    def _item(self, item: Node) -> Event | None:
        slug = clean(item.attributes.get("data-id"))
        title = node_text(item.css_first(".event__title"))
        day = _day(item)
        if not slug or not title or day is None:
            return None
        tickets = item.css_first("a.event__info__meta__tickets")
        ticket_url = tickets.attributes.get("href") if tickets is not None else None
        return Event(
            venue=self.info.slug,
            source_id=slug,
            title=title,
            start=combine(day, None),
            url=site_url(BASE, f"/club/{slug}"),
            city=self.info.city,
            categories=["Club"],
            ticket_url=ticket_url if ticket_url and ticket_url.startswith("https://") else None,
            extra={"time_known": False},
        )

    def redact(self, url: str, text: str) -> str:
        """Keep only the agenda (listing) or the event itself (event page): the pages
        also carry the whole agenda, navigation, scripts and inline SVG."""
        tree = HTMLParser(text)
        node = tree.css_first(".events" if url == AGENDA else ".single-content")
        return mask_emails(node.html or text) if node is not None else mask_emails(text)


def _day(item: Node) -> date | None:
    """ "23" and "October, 2026" from the item's two date links."""
    number = node_text(item.css_first(".event__date"))
    month_year = node_text(item.css_first(".event__info__meta__date"))
    if not number or not number.isdigit() or not month_year:
        return None
    month, _, year = month_year.partition(",")
    try:
        return date(int(year), month_number(month), int(number))
    except (KeyError, ValueError):
        return None
