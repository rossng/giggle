"""Johan Cruijff ArenA, Amsterdam-Zuidoost. Reads the calendar page.

The calendar (`/kalender/`, Craft CMS, one page) lists every upcoming event as a card:
title, an ISO `<time datetime>`, a type line ("Concert", "Dance", "Eredivisie", "UEFA
Conference League", "Oranje"…), kept verbatim as categories, a one-line teaser and a
picture. Football makes up most of it; concerts are a handful a year. The site has no
API or event JSON-LD, and robots.txt only disallows `/craft/`.

A card without a known time carries midnight ("2027-07-16T00:00:00+02:00"); those
events get `extra["time_known"] = False`. The "Koop tickets" label on a card means
tickets are on sale. Event pages are long, mostly visitor information in free text
(ticket links go to the promoter), so there is no `details()`.

`capacity` is the venue's own "ruim 55.000 stoelen" (its spreekbeurt page); concerts
with a standing floor hold more, but the venue doesn't publish that number.
"""

from __future__ import annotations

from collections.abc import Iterator

from selectolax.parser import HTMLParser, Node

from podia.extract import mask_emails, node_text, parse_iso, site_url
from podia.http import Fetcher
from podia.model import Availability, Event, VenueInfo
from podia.venue import FetchOptions, Venue, register

BASE = "https://www.johancruijffarena.nl"
CALENDAR = f"{BASE}/kalender/"


@register
class JohanCruijffArena(Venue):
    info = VenueInfo(
        slug="johancruijffarena",
        name="Johan Cruijff ArenA",
        city="Amsterdam",
        website=BASE,
        capacity=55_000,
    )

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        r = fetch.get(CALENDAR)
        r.raise_for_status()
        for card in HTMLParser(r.text).css("a.card[data-entry-id]"):
            event = self._card(card)
            if event is not None and event.start.date() >= options.since:
                yield event

    def _card(self, card: Node) -> Event | None:
        url = site_url(BASE, card.attributes.get("href"))
        entry = (card.attributes.get("data-entry-id") or "").strip()
        title = node_text(card.css_first(".card__title"))
        when = card.css_first("time[datetime]")
        start = parse_iso(when.attributes.get("datetime")) if when is not None else None
        if not url or "/kalender/" not in url or not entry.isdigit() or not title or not start:
            return None
        image = card.css_first("img.card__image__img")
        label = (node_text(card.css_first(".card__image__label")) or "").lower()
        if "uitverkocht" in label:
            availability = Availability.SOLD_OUT
        elif "koop tickets" in label:
            availability = Availability.ON_SALE
        else:
            availability = Availability.UNKNOWN
        return Event(
            venue=self.info.slug,
            source_id=entry,
            title=title,
            start=start,
            url=url,
            city=self.info.city,
            categories=[c for n in card.css(".card__meta") if (c := node_text(n))],
            availability=availability,
            description=node_text(card.css_first(".card__content")),
            image=image.attributes.get("src") if image is not None else None,
            extra={"time_known": False} if (start.hour, start.minute) == (0, 0) else {},
        )

    def redact(self, url: str, text: str) -> str:
        """Only the page's main content: the cards, without header, footer and scripts."""
        main = HTMLParser(text).css_first("main")
        return mask_emails(main.html or text if main is not None else text)
