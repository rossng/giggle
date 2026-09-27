"""De Nieuwe Anita, Amsterdam. Reads the homepage agenda, then the WordPress REST API for
each event's page content.

The homepage's agenda grid lists every upcoming event: title, day and month (no year),
start and end time. The REST API (`/wp-json/wp/v2/agenda`) has no dates of its own (no
ACF fields are exposed), but its rendered `content` is the event page's body: the event
type ("Live!", "Cinema", "Cabaret!"…), a free-text line with doors, prices and a ticket
link, the line-up and the description. One call fetches it for all listed events
(`include=<ids>`).

The line with doors and prices is the venue's own wording ("Deur 20.00, start 20.30.
12.5€ presale, door 13.5"); it is kept as the price text, with the amounts read from it.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from datetime import date, timedelta

from selectolax.parser import HTMLParser, Node

from podia.extract import (
    clean,
    combine,
    infer_year,
    mask_emails,
    month_number,
    node_text,
    strip_tags,
)
from podia.http import Fetcher
from podia.model import Availability, Event, Price, VenueInfo
from podia.venue import FetchOptions, Venue, register

BASE = "https://denieuweanita.nl"
HOME = f"{BASE}/"
API = f"{BASE}/wp-json/wp/v2/agenda"
PAGE_SIZE = 100
_DAY = re.compile(r"(\d{1,2})\s+([A-Za-z]+)")
_CLOCK = re.compile(r"\d{1,2}[:.]\d{2}")
_DOORS = re.compile(r"\b(?:deur(?:en)?|doors?)\s*(?:open)?\s*:?\s*(\d{1,2}[:.]\d{2})", re.I)
_START = re.compile(r"\b(?:start|starts|band)\s*:?\s*(\d{1,2}[:.]\d{2})", re.I)
# "€ 12", "12.5€", "10,-", "12 Euros", or "presale 10, door 12" ("door", not "doors").
_AMOUNT = re.compile(
    r"€\s*(\d+(?:[.,]\d{1,2})?)"
    r"|(\d+(?:[.,]\d{1,2})?)\s*(?:€|,-|euro)"
    r"|\b(?:presale|voorverkoop|door|doorsale|deurverkoop)\s*:?\s*(\d+(?:[.,]\d{1,2})?)(?![\d:])",
    re.I,
)
_LINEUP = re.compile(r"^\s*line[\s-]?up\s*:\s*(.+)$", re.I)


@register
class NieuweAnita(Venue):
    info = VenueInfo(slug="nieuweanita", name="De Nieuwe Anita", city="Amsterdam", website=BASE)

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        r = fetch.get(HOME)
        r.raise_for_status()
        listed = [e for e in (self._item(a, options.since) for a in _agenda(r.text)) if e]
        posts: dict[str, dict] = {}
        ids = [e.source_id for e in listed]
        for page, i in enumerate(range(0, len(ids), PAGE_SIZE)):
            if options.max_pages is not None and page >= options.max_pages:
                break
            params = {
                "include": ",".join(ids[i : i + PAGE_SIZE]),
                "per_page": str(PAGE_SIZE),
                "_fields": "id,title,content",
            }
            r = fetch.get(API, params=params)
            r.raise_for_status()
            posts.update({str(item["id"]): item for item in r.json()})
        for event in listed:
            if post := posts.get(event.source_id):
                # The grid shortens long titles ("Witte Gei't? met Matthew C Whitaker,…").
                event.title = clean(strip_tags(post["title"]["rendered"])) or event.title
                # Line breaks become spaces; inline tags don't ("<b>Trashma</b><b>n</b>").
                body = re.sub(r"<br\s*/?>", "\n", post["content"]["rendered"])
                _add_content(event, HTMLParser(body))
            yield event

    def _item(self, item: Node, since: date) -> Event | None:
        post_id = item.attributes.get("data-id")
        link = item.css_first("a[href]")
        title = node_text(item.css_first(".entry-title"))
        day = _day(node_text(item.css_first("._space_yearless_date")), since)
        if not post_id or link is None or not title or day is None:
            return None
        start_clock = node_text(item.css_first(".agenda_time_start"))
        end_clock = node_text(item.css_first(".agenda_time_end"))
        has_time = bool(start_clock and _CLOCK.search(start_clock))
        start = combine(day, start_clock if has_time else None)
        end = None
        if has_time and end_clock and _CLOCK.search(end_clock):
            end = combine(day, end_clock)
            if end <= start:
                end += timedelta(days=1)  # "20:30 — 01:00"
        return Event(
            venue=self.info.slug,
            source_id=post_id,
            title=title,
            start=start,
            url=link.attributes.get("href"),
            end=end,
            city=self.info.city,
            extra={} if has_time else {"time_known": False},
        )

    def redact(self, url: str, text: str) -> str:
        return mask_emails(self._trim(url, text))

    def _trim(self, url: str, text: str) -> str:
        """Homepage: only the agenda grid's items. REST: only the parts of the content
        read here (the type and the text columns)."""
        if url == HOME:
            items = _agenda(text)
            for item in items:
                for img in item.css("img"):
                    img.decompose()
            return "\n".join(item.html or "" for item in items)
        if url == API:
            items = json.loads(text)
            for item in items:
                tree = HTMLParser(item["content"]["rendered"])
                kept = [n for n in tree.css(".agenda_type, .wpb_text_column") if not _nested(n)]
                for node in kept:
                    for img in node.css("img"):
                        img.decompose()
                item["content"]["rendered"] = "\n".join(node.html or "" for node in kept)
            return json.dumps(items, ensure_ascii=False)
        return text


def _nested(node: Node) -> bool:
    """Whether `node` sits inside another text column (they are sometimes nested)."""
    parent = node.parent
    while parent is not None:
        if "wpb_text_column" in (parent.attributes.get("class") or "").split():
            return True
        parent = parent.parent
    return False


def _agenda(page: str) -> list[Node]:
    """The homepage grid items that have a date (the featured grid above has none)."""
    tree = HTMLParser(page)
    return [
        a for a in tree.css("article.w-grid-item[data-id]") if a.css_first("._space_yearless_date")
    ]


def _day(text: str | None, since: date) -> date | None:
    """ "6 Oct": the year is the first that doesn't put it (much) before `since`."""
    m = _DAY.search(text or "")
    if not m:
        return None
    try:
        month = month_number(m[2])
    except KeyError:
        return None
    return infer_year(month, int(m[1]), since)


def _add_content(event: Event, tree: HTMLParser) -> None:
    """Type, doors, price, ticket link, line-up and description from the page body."""
    if kind := node_text(tree.css_first(".agenda_type .w-post-elm-value")):
        event.categories = [kind.strip("—– ")]
    paragraphs = [p for p in tree.css(".wpb_text_column p") if node_text(p, "")]
    info = paragraphs[0] if paragraphs else None
    rest = paragraphs[1:]
    info_text = node_text(info, "") or ""
    if info is not None and (
        _DOORS.search(info_text) or _AMOUNT.search(info_text) or "ticket" in info_text.lower()
    ):
        _add_times(event, info_text)
        event.price = _price(info_text)
        for a in info.css("a[href]"):
            href = a.attributes.get("href") or ""
            if href.startswith("http") and not href.startswith(BASE):
                event.ticket_url = href
                break
    else:
        rest = paragraphs
    description = []
    for p in rest:
        text = node_text(p, "") or ""
        if m := _LINEUP.match(text):
            event.performers = [
                s for s in (clean(x) for x in re.split(r",|\s&\s|\s\+\s", m[1])) if s
            ]
        else:
            description.append(text)
    event.description = clean(" ".join(description))
    lowered = info_text.lower()
    if "uitverkocht" in lowered or "sold out" in lowered:
        event.availability = Availability.SOLD_OUT
    elif event.price is not None and event.price.max_eur == 0:
        event.availability = Availability.FREE
    elif event.ticket_url:
        event.availability = Availability.ON_SALE


def _add_times(event: Event, text: str) -> None:
    """Doors and start from "Deur 20.00, start 21.00". The grid's time is usually the
    start, sometimes the doors; a stated start up to four hours after it wins then. The
    text is copied between editions at times, so a door time after the start is dropped.
    """
    day = event.start.date()
    doors = combine(day, m[1]) if (m := _DOORS.search(text)) else None
    start = combine(day, m[1]) if (m := _START.search(text)) else None
    if event.extra.get("time_known", True) is False:
        if start is not None:
            event.start = start
            event.extra["time_known"] = True
        elif doors is not None:
            event.start = doors
            event.extra["time_known"] = True
    elif (
        start is not None
        and doors == event.start
        and event.start < start <= event.start + timedelta(hours=4)
    ):
        event.start = start
    if doors is not None and doors <= event.start:
        event.doors = doors
    if event.end is not None and event.end <= event.start:
        event.end = None


def _price(text: str) -> Price | None:
    """Amounts written "12.5€", "€ 8", "8,-" or "13 euro"; "gratis"/"free" is 0."""
    lowered = text.lower()
    amounts = [float(next(g for g in m if g).replace(",", ".")) for m in _AMOUNT.findall(text)]
    if not amounts:
        if re.search(r"\b(gratis|free|vrij entree|free entry)\b", lowered):
            return Price(0.0, 0.0, text)
        return None
    return Price(min(amounts), max(amounts), text)
