"""De Helling, Utrecht. Reads the agenda page, once whole and once per type ("label"), and,
through `details()`, each event's own page.

The agenda (`dehelling.nl/agenda/`, one page, no paging) lists every upcoming event as a
card carrying a schema.org Event in JSON-LD: title, start ("Aanvang") and end, poster,
the subtitle as `description`, and an offer with the price and Stager ticket link. The
card itself adds the door time (its first clock, "19:30 - 23:00", is when the hall
opens), the genre tags ("Postpunk", "Bass Music", "Tribute"…) and a banner for sold-out
("uitverkocht") and cancelled ("afgelast") events. The WordPress REST API is disallowed
by robots.txt.

Not used: the JSON-LD `performer`, a lower-cased slug of a name that is as often the
promoter's night as an act ("set the bar "); its `offers.availability`, which says
SoldOut for events still on sale; and its `eventStatus`, which is missing for some
sold-out and cancelled events the banners do mark.

The type of event (Concert, Club, Festival, Cross-over, OPEN…) isn't on the cards; the
agenda's filter (`?label[]=club`) lists the events of one type, so each type in the
filter form is asked for once and its name becomes a category of the events it lists.

`details()` reads the event page for the full description and the ticket button's state
("Tickets", "uitverkocht", "afgelast").
"""

from __future__ import annotations

import copy
import json
import re
from collections.abc import Iterator
from typing import Any

from selectolax.parser import HTMLParser, Node

from podia.extract import clean, combine, mask_emails, node_text, parse_iso, site_url
from podia.http import Fetcher
from podia.model import Availability, Event, Price, Status, VenueInfo
from podia.venue import FetchOptions, Venue, register

BASE = "https://dehelling.nl"
AGENDA = f"{BASE}/agenda/"
_CLOCK = re.compile(r"\d{1,2}:\d{2}")
_SLUG = re.compile(r"/agenda/([a-z0-9_-]+)/?$")


@register
class Helling(Venue):
    info = VenueInfo(slug="helling", name="De Helling", city="Utrecht", website=BASE)
    has_details = True

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        r = fetch.get(AGENDA)
        r.raise_for_status()
        tree = HTMLParser(r.text)
        labels = self._labels(fetch, tree)
        for card in tree.css(".t-agenda__results .c-event-card"):
            event = self._item(card)
            if event is None or event.start.date() < options.since:
                continue
            event.categories = labels.get(event.source_id, [])
            yield event

    def details(self, fetch: Fetcher, event: Event) -> Event:
        if not event.url:
            return event
        r = fetch.get(event.url)
        r.raise_for_status()
        tree = HTMLParser(r.text)
        e = copy.deepcopy(event)
        text = tree.css_first(".c-event-content__text")
        if description := node_text(text):
            e.description = description
        button = tree.css_first(".c-event-meta__button")
        state = (node_text(button) or "").lower()
        if "afgelast" in state:
            e.status = Status.CANCELLED
        elif "uitverkocht" in state:
            e.availability = Availability.SOLD_OUT
        elif (
            button is not None
            and button.css_first("a[href]") is not None
            and e.availability is Availability.UNKNOWN
        ):
            e.availability = Availability.ON_SALE
        return e

    def _labels(self, fetch: Fetcher, tree: HTMLParser) -> dict[str, list[str]]:
        """Event id → the names of the types the agenda's filter lists it under."""
        labels: dict[str, list[str]] = {}
        for box in tree.css('form.c-filter input[name="label[]"]'):
            value = box.attributes.get("value")
            label = tree.css_first(f'label[for="label_{value}"]') if value else None
            name = node_text(label)
            if not value or not name or not re.fullmatch(r"[a-z0-9-]+", value):
                continue
            r = fetch.get(AGENDA, params={"label[]": value})
            if r.status >= 400:
                continue
            for card in HTMLParser(r.text).css(".t-agenda__results .c-event-card"):
                if (key := card.attributes.get("id")) and name not in labels.setdefault(key, []):
                    labels[key].append(name)
        return labels

    def _item(self, card: Node) -> Event | None:
        data = _event_ld(card)
        link = card.css_first("a.c-event-card__link[href]")
        url = site_url(BASE, link.attributes.get("href") if link is not None else None)
        m = _SLUG.search(url or "")
        title = node_text(link) or clean(data.get("name"))
        start = parse_iso(data.get("startDate"))
        if not m or not title or start is None or card.attributes.get("id") != m[1]:
            return None
        meta = [t for li in card.css(".c-event-card__meta li") if (t := node_text(li))]
        # "zo 18/10", "19:30 - 23:00", then the genre tags.
        genres = [t for t in meta[2:] if not _CLOCK.search(t)]
        doors = None
        if len(meta) > 1 and (clock := _CLOCK.search(meta[1])):
            opens = combine(start.date(), clock[0])
            doors = opens if opens < start else None
        banners = {
            b.attributes.get("class", "").rsplit("--", 1)[-1]
            for b in card.css(".c-event-card__banner")
        }
        offer = data.get("offers") if isinstance(data.get("offers"), dict) else {}
        price = _price(offer.get("price"))
        ticket = offer.get("url")
        availability = Availability.UNKNOWN
        if "uitverkocht" in banners:
            availability = Availability.SOLD_OUT
        elif price is not None and price.max_eur == 0:
            availability = Availability.FREE
        image = data.get("image")
        return Event(
            venue=self.info.slug,
            source_id=m[1],
            title=title,
            start=start,
            url=url,
            subtitle=node_text(card.css_first(".c-event-card__subtitle")),
            doors=doors,
            end=parse_iso(data.get("endDate")),
            city=self.info.city,
            genres=genres,
            status=Status.CANCELLED if "afgelast" in banners else Status.SCHEDULED,
            availability=availability,
            price=price,
            ticket_url=ticket
            if isinstance(ticket, str) and ticket.startswith("https://")
            else None,
            image=image if isinstance(image, str) and image.startswith("https://") else None,
        )

    def redact(self, url: str, text: str) -> str:
        """Agenda: only the filter form and the results. Event page: only the event's
        meta block and text. Sentry keys, scripts and the footer's contact details go."""
        tree = HTMLParser(text)
        if url.split("?", 1)[0] == AGENDA:
            selectors = ["form.c-filter", ".t-agenda__results"]
        else:
            selectors = [".c-event-meta", ".c-event-content__text"]
        parts = [n.html or "" for s in selectors if (n := tree.css_first(s)) is not None]
        return mask_emails("\n".join(parts) if parts else text)


def _event_ld(card: Node) -> dict[str, Any]:
    for script in card.css('script[type="application/ld+json"]'):
        try:
            data = json.loads(script.text(strip=True))
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and data.get("@type") == "Event":
            return data
    return {}


def _price(value: Any) -> Price | None:
    """The offer's price, "29.50": the ticket price including the service fee."""
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return None
    return Price(amount, amount)
