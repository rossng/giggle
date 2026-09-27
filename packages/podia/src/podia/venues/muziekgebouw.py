"""Muziekgebouw aan 't IJ, Amsterdam. Reads the paginated agenda plus its genre pages.

The agenda (`/nl/agenda?p54_page=N`, 20 cards a page, ~19 pages) has nearly everything
on the card: title, subtitle, tagline, date and time, room (Grote Zaal, Bimhuis…), every
tariff in a price popover, the ticket link and a `status-…` class (normaal, uitverkocht,
gratis, geannuleerd). Genres are only on detail pages, and robots.txt disallows the
`?genres[]=` filter and asks for a 5 s crawl delay, so ~370 detail pages would take half
an hour. Instead the genres come from the site's path-based genre pages
(`/nl/agenda/klassiekemuziek`, paginated the same way), about 30 extra requests. Events
in the Bimhuis are Bimhuis's own but listed here too; they keep room "Bimhuis".
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from datetime import date

from selectolax.parser import HTMLParser, Node

from podia.extract import combine, month_number, node_text, parse_price
from podia.http import Fetcher
from podia.model import Availability, Event, Price, Status, VenueInfo
from podia.venue import FetchOptions, Venue, register

BASE = "https://www.muziekgebouw.nl"
AGENDA = f"{BASE}/nl/agenda"
# Genre page slug → the genre's name as the detail pages and the genre filter show it.
# These are the nine genres of the agenda filter; the site's other tags (piano, orkest,
# première…) also have pages but are not genres.
GENRE_PAGES = {
    "hedendaagsemuziek": "hedendaags",
    "klassiekemuziek": "klassiek",
    "oudemuziek": "oud",
    "jazzmuziek": "jazz",
    "popmuziek": "pop",
    "elektronischemuziek": "elektronisch",
    "global": "global",
    "filmenmuziek": "film",
    "familieconcert": "familie",
}
_DATE = re.compile(r"(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})")
_STATUSES = {
    "uitverkocht": Availability.SOLD_OUT,
    "gratis": Availability.FREE,
    "normaal": Availability.ON_SALE,
}


@register
class Muziekgebouw(Venue):
    info = VenueInfo(
        slug="muziekgebouw",
        name="Muziekgebouw aan 't IJ",
        city="Amsterdam",
        website=BASE,
    )

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        genres: dict[str, list[str]] = {}
        for slug, genre in GENRE_PAGES.items():
            for card in _cards(fetch, f"{AGENDA}/{slug}", options.max_pages):
                genres.setdefault(card.attributes["data-entry-id"] or "", []).append(genre)
        for card in _cards(fetch, AGENDA, options.max_pages):
            event = self._card(card)
            if event is not None:
                event.genres = genres.get(event.source_id, [])
                yield event

    def _card(self, card: Node) -> Event | None:
        entry_id = card.attributes.get("data-entry-id") or ""
        title = node_text(card.css_first("h3.title"))
        m = _DATE.search(node_text(card.css_first(".top-date .start")) or "")
        if not entry_id or not title or m is None:
            return None
        day = date(int(m[3]), month_number(m[2]), int(m[1]))
        clocks = re.findall(r"\d{1,2}[:.]\d{2}", node_text(card.css_first(".top-date .time")) or "")
        link = card.css_first("a.desc")
        image = card.css_first(".thumb img")
        button = card.css_first(".meta-group.button [class*='status-']")
        availability, status, ticket_url, extra = _button(button)
        tariffs = _tariffs(card)
        if tariffs:
            extra["tariffs"] = tariffs
        return Event(
            venue=self.info.slug,
            source_id=entry_id,
            title=title,
            start=combine(day, clocks[0] if clocks else None),
            end=combine(day, clocks[1]) if len(clocks) > 1 else None,
            url=BASE + href if link is not None and (href := link.attributes.get("href")) else None,
            subtitle=node_text(card.css_first(".subtitle")),
            room=node_text(card.css_first(".venue")),
            city=self.info.city,
            status=status,
            availability=availability,
            price=_price(card, tariffs),
            ticket_url=ticket_url,
            description=node_text(card.css_first(".tagline")),
            image=image.attributes.get("src") if image is not None else None,
            extra=extra,
        )

    def redact(self, url: str, text: str) -> str:
        """Keep the event cards (without icons and responsive-image sources) and the
        pagination links. Genre pages are only read for their card ids."""
        tree = HTMLParser(text)
        cards = tree.css("li.eventCard[data-entry-id]")
        pages = [a.html or "" for a in tree.css('a[href*="_page="]')]
        if url.split("?")[0] != AGENDA:
            ids = [c.attributes["data-entry-id"] for c in cards]
            kept = [f'<li class="eventCard" data-entry-id="{i}"></li>' for i in ids]
            return "\n".join(kept + pages)
        for node in tree.css("li.eventCard svg, li.eventCard picture source"):
            node.decompose()
        kept = [re.sub(r"\s*\n\s*", "\n", c.html or "") for c in cards]
        return "\n".join(kept + pages)


def _cards(fetch: Fetcher, url: str, max_pages: int | None) -> Iterator[Node]:
    """Cards from `url?p54_page=1, 2…` until a page has no link to the next one."""
    page = 1
    while max_pages is None or page <= max_pages:
        # The page number goes in the URL itself (not `params`) so `redact` sees the path
        # it belongs to; robots.txt only allows query strings of this `?p*_page=` form.
        r = fetch.get(f"{url}?p54_page={page}")
        r.raise_for_status()
        tree = HTMLParser(r.text)
        cards = tree.css("li.eventCard[data-entry-id]")
        yield from cards
        if not cards or tree.css_first(f'a[href*="p54_page={page + 1}"]') is None:
            return
        page += 1


def _button(button: Node | None) -> tuple[Availability, Status, str | None, dict[str, object]]:
    """The order button: `status-normaal` "In winkelmandje", `status-uitverkocht`,
    `status-gratis`, `status-geannuleerd`, or a bare `status-` with its own wording
    ("Laatste kaarten", "Bestel via Bimhuis", "Niet verkoopbaar")."""
    if button is None:
        return Availability.UNKNOWN, Status.SCHEDULED, None, {}
    classes = button.attributes.get("class") or ""
    label = node_text(button) or ""
    states = [c.removeprefix("status-") for c in classes.split() if c.startswith("status-")]
    state = next((s for s in states if s and s != "info"), "")
    extra: dict[str, object] = {"ticket_label": label} if label else {}
    href = button.attributes.get("href") or ""
    ticket_url = href if "btn-order" in classes and href.startswith("http") else None
    if state == "geannuleerd":
        return Availability.UNKNOWN, Status.CANCELLED, ticket_url, extra
    if label.lower() == "laatste kaarten":
        return Availability.FEW_LEFT, Status.SCHEDULED, ticket_url, extra
    if label.lower() == "niet verkoopbaar":
        return Availability.UNKNOWN, Status.SCHEDULED, ticket_url, extra
    return _STATUSES.get(state, Availability.UNKNOWN), Status.SCHEDULED, ticket_url, extra


def _tariffs(card: Node) -> list[dict[str, object]]:
    """Every row of the price popover: rank (seat category), tariff name and amount."""
    tariffs: list[dict[str, object]] = []
    rank = None
    for row in card.css(".item-prices tr"):
        if (name := row.css_first(".rank-name")) is not None:
            rank = node_text(name)
            continue
        kind, amount = node_text(row.css_first(".pricetype")), node_text(row.css_first(".price"))
        parsed = parse_price(amount)
        if kind and parsed is not None and parsed.min_eur is not None:
            tariffs.append({"rank": rank, "type": kind, "eur": parsed.min_eur})
    return tariffs


def _price(card: Node, tariffs: list[dict[str, object]]) -> Price | None:
    text = node_text(card.css_first(".pricePopoverBtn"))
    amounts = [float(t["eur"]) for t in tariffs]  # type: ignore[arg-type]
    if amounts:
        return Price(min(amounts), max(amounts), text)
    return parse_price(text)
