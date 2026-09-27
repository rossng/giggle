"""Nobel, Leiden. Reads the Drupal agenda page and its event-type filters and, through
`details()`, each event's own page.

The agenda lists every event on one page with title, subtitle, genre tags, an age limit
and labels such as "Uitverkocht", "Laatste tickets" or "Gratis". Its `<time datetime>`
is when the page was created, not the event date; the date is read from the URL slug
(`/agenda/audrey-horne-13-oct-2026`) instead. The cards have no time, so a listed
event's `start` is its date at 00:00 Amsterdam time and `extra["time_known"]` is False.
Event types (Concert, Clubnacht, Festival, Overig) are not on the cards but the agenda
can be filtered by them, which costs one request per type (about five requests in all).

`details()` reads the event page for the start time (then `time_known` is True), room,
"Prijs vanaf", the ticket link, support acts and the intro.
"""

from __future__ import annotations

import copy
import re
from collections.abc import Iterator
from datetime import date
from urllib.parse import urlencode

from selectolax.parser import HTMLParser, Node

from podia.extract import combine, infer_year, month_number, node_text, parse_price
from podia.http import Fetcher
from podia.model import Availability, Event, Price, Status, VenueInfo
from podia.venue import FetchOptions, Venue, register

BASE = "https://nobel.nl"
AGENDA = f"{BASE}/agenda"
_SLUG_DATE = re.compile(r"-(\d{1,2})-([a-z]+)-(\d{4})$")
_CARD_DATE = re.compile(r"(\d{1,2})\s+([a-z]+)")
_CLOCK = re.compile(r"^\d{1,2}[:.]\d{2}")
_LABELS = {
    "uitverkocht": Availability.SOLD_OUT,
    "laatste tickets": Availability.FEW_LEFT,
    "gratis": Availability.FREE,
}
_STATUSES = {"geannuleerd": Status.CANCELLED, "afgelast": Status.CANCELLED}


@register
class Nobel(Venue):
    info = VenueInfo(slug="nobel", name="Nobel", city="Leiden", website=BASE)
    has_details = True

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        r = fetch.get(AGENDA)
        r.raise_for_status()
        page = HTMLParser(r.text)
        types = _event_types(fetch, page)
        for card in page.css('a.event[href^="/agenda/"]'):
            event = self._card(card, options.since)
            if event is None:
                continue
            event.categories = types.get(event.source_id, [])
            yield event

    def details(self, fetch: Fetcher, event: Event) -> Event:
        if not event.url:
            return event
        r = fetch.get(event.url)
        r.raise_for_status()
        e = copy.deepcopy(event)
        _add_detail(e, HTMLParser(r.text))
        return e

    def _card(self, card: Node, since: date) -> Event | None:
        href = card.attributes.get("href") or ""
        slug = href.rsplit("/", 1)[-1]
        title = node_text(card.css_first(".content h3"))
        day = _slug_date(slug) or _card_date(node_text(card.css_first(".time")), since)
        if not title or day is None:
            return None
        labels = list(dict.fromkeys(t for n in card.css(".special-label") if (t := node_text(n))))
        extra: dict[str, object] = {"time_known": False}
        if labels:
            extra["labels"] = labels
        if age := node_text(card.css_first(".age")):
            extra["age"] = age
        image = card.css_first(".image img")
        src = image.attributes.get("src") if image is not None else None
        lowered = [label.lower() for label in labels]
        return Event(
            venue=self.info.slug,
            source_id=slug,
            title=title,
            start=combine(day, None),
            url=BASE + href,
            subtitle=node_text(card.css_first(".content p")),
            city=self.info.city,
            genres=[t for n in card.css(".genre") if (t := node_text(n))],
            status=next((_STATUSES[s] for s in lowered if s in _STATUSES), Status.SCHEDULED),
            availability=next((_LABELS[s] for s in lowered if s in _LABELS), Availability.UNKNOWN),
            image=BASE + src if src else None,
            extra=extra,
        )

    def redact(self, url: str, text: str) -> str:
        """Keep the agenda's filter form and event list, or a detail page's two event
        sections, without template indentation. Filtered agendas are only read for
        their links, so only those are kept."""
        tree = HTMLParser(text)
        if url == AGENDA:
            for node in tree.css("[data-inview]"):
                del node.attrs["data-inview"]
            nodes = tree.css("form#views-exposed-form-events-overview-overview-block, .soon")
        elif url.startswith(AGENDA + "/"):
            nodes = tree.css("section.event-page, section.event-content")
        else:
            links = tree.css('a.event[href^="/agenda/"]')
            return "\n".join(f'<a href="{a.attributes["href"]}" class="event"></a>' for a in links)
        kept = "\n".join(n.html or "" for n in nodes)
        return re.sub(r"\s*\n\s*", "\n", kept) if kept else text


def _slug_date(slug: str) -> date | None:
    """`audrey-horne-13-oct-2026` → 2026-10-13 (English month abbreviations)."""
    m = _SLUG_DATE.search(slug)
    try:
        return date(int(m[3]), month_number(m[2]), int(m[1])) if m else None
    except (KeyError, ValueError):
        return None


def _card_date(text: str | None, since: date) -> date | None:
    """Fallback for "za. 26 sept." without a year."""
    m = _CARD_DATE.search(text or "")
    if m is None:
        return None
    try:
        month = month_number(m[2])
    except KeyError:
        return None
    return infer_year(month, int(m[1]), since)


def _event_types(fetch: Fetcher, page: HTMLParser) -> dict[str, list[str]]:
    """Event slug → event types, from one filtered agenda per type in the filter form."""
    form = page.css_first("form#views-exposed-form-events-overview-overview-block")
    if form is None:
        return {}
    types: dict[str, list[str]] = {}
    for box in form.css('input[name^="type["]'):
        name, value = box.attributes.get("name"), box.attributes.get("value")
        label = form.css_first(f'label[for="{box.attributes.get("id")}"]')
        if not name or not value or label is None or not (type_name := node_text(label)):
            continue
        # The filter goes in the URL itself so `redact` can tell these pages apart.
        r = fetch.get(f"{AGENDA}?{urlencode({name: value})}")
        if r.status >= 400:
            continue
        for a in HTMLParser(r.text).css('a.event[href^="/agenda/"]'):
            slug = (a.attributes.get("href") or "").rsplit("/", 1)[-1]
            types.setdefault(slug, []).append(type_name)
    return types


def _add_detail(event: Event, tree: HTMLParser) -> None:
    """Start time, room, price, ticket link, support act and intro from a detail page,
    into `event` (a copy of the listed one).

    The info block is a row of unlabelled spans: time, room, age (`.age`), then the genre
    tags already known from the card. The room is the one that is neither.
    """
    info = tree.css_first("section.event-page .info--content")
    if info is None:
        return
    genres = " ".join(event.genres)
    for span in info.css(".info--tags > span"):
        text = node_text(span)
        if not text or "age" in (span.attributes.get("class") or ""):
            continue
        if _CLOCK.match(text):
            event.start = combine(event.start.date(), text)
            event.extra["time_known"] = True
        elif event.room is None and text != genres:
            event.room = text
    tickets = tree.css_first("section.event-page .tickets")
    if tickets is not None and (price := _price(tickets)) is not None:
        event.price = price
        if price.max_eur == 0 and event.availability is not Availability.SOLD_OUT:
            event.availability = Availability.FREE
    link = tree.css_first("section.event-page .info a[href^='http']")
    if link is not None:
        href = re.sub(r"&_gl=[^&#]*", "", link.attributes.get("href") or "")
        event.ticket_url = href or event.ticket_url
    if event.availability is Availability.UNKNOWN and event.ticket_url:
        event.availability = Availability.ON_SALE
    for heading in tree.css("section.event-content h3"):
        text = node_text(heading) or ""
        if text.lower().startswith("support:"):
            names = [s.strip() for s in text.split(":", 1)[1].split(" + ") if s.strip()]
            event.support += [n for n in names if n not in event.support]
    if intro := node_text(tree.css_first("section.event-content p.event-intro")):
        event.description = intro


def _price(tickets: Node) -> Price | None:
    """ "Prijs vanaf: € 29,90" is a lowest price; a title "Gratis entree" means free."""
    title = node_text(tickets.css_first(".tickets-title"))
    if title and "gratis" in title.lower():
        return Price(0.0, 0.0, title)
    for p in tickets.css("p"):
        text = node_text(p)
        if text and "€" in text:
            amount = parse_price(text.split(":", 1)[-1])
            if amount is not None and amount.min_eur is not None:
                vanaf = "vanaf" in text.lower()
                return Price(amount.min_eur, None if vanaf else amount.max_eur, text)
    return None
