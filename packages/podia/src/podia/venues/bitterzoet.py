"""Bitterzoet, Amsterdam. Reads the agenda the WordPress theme loads through admin-ajax.

The agenda page itself only shows this week; the rest comes from a form-encoded POST to
`admin-ajax.php` (`action=load_agenda_results`, a JSON `query` and a nonce printed in
the page). With `month` left empty that returns every upcoming event: date, doors time,
price, title, a genre line and the ticket link (Paradiso, weticket.io…). The same call
filtered by the agenda's "concert" and "clubnacht" buttons gives the event types. The
REST API (`/wp-json/wp/v2/event`) and the RSS feed carry no event dates, and there is no
JSON-LD or iCal feed.

Events this week and next say "Vandaag" or "Morgen" instead of a date; for those the
detail page is fetched, whose add-to-calendar button has the full start and end.
"""

from __future__ import annotations

import base64
import json
import re
from collections.abc import Iterator
from datetime import date, datetime, timedelta

from selectolax.parser import HTMLParser, Node

from podia.extract import combine, month_number, node_text, parse_iso
from podia.http import Fetcher, Response
from podia.model import Availability, Event, Price, Status, VenueInfo
from podia.venue import FetchOptions, Venue, register

BASE = "https://www.bitterzoet.com"
AGENDA = f"{BASE}/agenda/"
AJAX = f"{BASE}/wp-admin/admin-ajax.php"
# Detail pages fetched per unit of `max_pages`; they are only needed for relative dates.
DETAILS_PER_PAGE = 5
_NONCE = re.compile(r'"agendaNonce"\s*:\s*"(\w+)"')
_DATE = re.compile(r"(\d{1,2})\s+([a-z]+)\s+(\d{4})")
_MARKER = re.compile(r"\s*\[(sold out|uitverkocht|cancell?ed|geannuleerd|postponed)\]\s*$", re.I)
_MARKERS = {
    "sold out": (Status.SCHEDULED, Availability.SOLD_OUT),
    "uitverkocht": (Status.SCHEDULED, Availability.SOLD_OUT),
    "canceled": (Status.CANCELLED, Availability.UNKNOWN),
    "cancelled": (Status.CANCELLED, Availability.UNKNOWN),
    "geannuleerd": (Status.CANCELLED, Availability.UNKNOWN),
    "postponed": (Status.POSTPONED, Availability.UNKNOWN),
}


@register
class Bitterzoet(Venue):
    info = VenueInfo(slug="bitterzoet", name="Bitterzoet", city="Amsterdam", website=BASE)

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        r = fetch.get(AGENDA)
        r.raise_for_status()
        nonce = _nonce(r.text)
        if nonce is None:
            raise ValueError("bitterzoet: no agenda nonce on the agenda page")
        page = HTMLParser(r.text)
        # Event slug → types, from the agenda's own filter buttons (concert, clubnacht).
        types: dict[str, list[str]] = {}
        for button in page.css(".agenda-page__filters__filter[data-filter]"):
            label, name = button.attributes.get("data-filter"), node_text(button)
            if label and name and label != "all":
                for item in _items(fetch, nonce, label):
                    types.setdefault(_slug(item) or "", []).append(name)
        budget = None if options.max_pages is None else options.max_pages * DETAILS_PER_PAGE
        for item in _items(fetch, nonce, "all"):
            event = self._item(item, types)
            if event is None:
                continue
            if event.start is _UNDATED:
                if budget is not None and budget <= 0:
                    continue  # no date without the detail page; skip rather than guess
                if budget is not None:
                    budget -= 1
                if not _add_dates(event, fetch.get(event.url or "")):
                    continue
            yield event

    def _item(self, item: Node, types: dict[str, list[str]]) -> Event | None:
        slug = _slug(item)
        title = node_text(item.css_first(".title-component"))
        if not slug or not title:
            return None
        # "zondag 4 oktober  2026 / 19:30 / €23.70", or "Morgen / 19:30 / …"
        when = node_text(item.css_first(".agenda-item__date-time-price")) or ""
        day_text, _, rest = when.partition("/")
        clock = rest.split("/")[0].strip() or None
        m = _DATE.search(day_text.lower())
        start = combine(date(int(m[3]), month_number(m[2]), int(m[1])), clock) if m else _UNDATED
        status, availability = Status.SCHEDULED, Availability.UNKNOWN
        if marker := _MARKER.search(title):
            status, availability = _MARKERS[marker[1].lower()]
            title = title[: marker.start()].strip()
        amount = node_text(item.css_first(".agenda-item__price"))
        price = None
        if amount and re.fullmatch(r"\d+(?:[.,]\d+)?", amount):
            value = float(amount.replace(",", "."))
            price = Price(value, value, None)
        ticket_url = next(
            (
                href
                for a in item.css(".agenda-item__buy-tickets a[href]")
                if (href := a.attributes.get("href")) and not href.startswith(BASE)
            ),
            None,
        )
        if availability is Availability.UNKNOWN and ticket_url and status is Status.SCHEDULED:
            availability = Availability.ON_SALE
        line = node_text(item.css_first(".agenda-item__subtitle"))
        image = re.search(r"url\(([^)]+)\)", _style(item.css_first(".agenda-item__image")))
        return Event(
            venue=self.info.slug,
            source_id=slug,
            title=title,
            start=start,
            url=f"{BASE}/event/{slug}/",
            subtitle=line,
            # The listing time is when the doors open ("deuren open" on the detail page).
            doors=start if start is not _UNDATED and clock else None,
            city=self.info.city,
            # The subtitle line is the venue's genre list: "Hip-Hop, Electronic, Soul".
            genres=[g.strip() for g in (line or "").split(",") if g.strip()],
            categories=types.get(slug, []),
            status=status,
            availability=availability,
            price=price,
            ticket_url=ticket_url,
            image=image[1].strip("'\"") if image else None,
        )

    def redact(self, url: str, text: str) -> str:
        """Agenda page: only the nonce and the filter buttons. Agenda results: the items
        without their icons. Detail page: only the event block."""
        if url == AJAX:
            content = json.loads(text).get("content", "")
            content = re.sub(r"<svg.*?</svg>", "", content, flags=re.S)
            return json.dumps({"content": re.sub(r"\s*\n\s*", "\n", content)})
        tree = HTMLParser(text)
        if url == AGENDA:
            nonce = _nonce(text) or ""
            filters = tree.css_first(".agenda-page__filters")
            for svg in filters.css("svg") if filters is not None else []:
                svg.decompose()
            args = json.dumps({"agendaNonce": nonce})
            return f"<script>var jsArgs = {args};</script>\n{filters.html if filters else ''}"
        node = tree.css_first(".event-detail__event-component")
        return node.html or text if node is not None else text


# Placeholder start for items that only say "Vandaag"/"Morgen"; replaced from the
# detail page before the event is yielded.
_UNDATED = parse_iso("1970-01-01T00:00:00+00:00")


def _style(node: Node | None) -> str:
    return (node.attributes.get("style") or "") if node is not None else ""


def _slug(item: Node) -> str | None:
    for a in item.css(f'a[href^="{BASE}/event/"]'):
        return (a.attributes.get("href") or "").rstrip("/").rsplit("/", 1)[-1] or None
    return None


def _nonce(page: str) -> str | None:
    """The nonce is in `jsArgs`, printed in a base64 `data:` script (or inline)."""
    if m := _NONCE.search(page):
        return m[1]
    for data in re.findall(r'src="data:text/javascript;base64,([^"]+)"', page):
        decoded = base64.b64decode(data).decode("utf-8", "replace")
        if m := _NONCE.search(decoded):
            return m[1]
    return None


def _items(fetch: Fetcher, nonce: str, label: str) -> list[Node]:
    """One call to the agenda's AJAX endpoint (a form POST): every upcoming item for a
    filter label."""
    query = json.dumps({"label": label, "query": "", "month": ""})
    form = {"action": "load_agenda_results", "query": query, "agendaNonce": nonce}
    r = fetch.post(AJAX, data=form)
    r.raise_for_status()
    content = r.json().get("content", "") if r.text.strip() else ""
    return HTMLParser(content).css(".agenda-item") if content else []


def _add_dates(event: Event, r: Response) -> bool:
    """Start and end from the detail page's add-to-calendar data:
    `data-share='{"title": …, "start": "2026-09-27 19:30:00", "end": "…"}'`."""
    if r.status >= 400:
        return False
    node = HTMLParser(r.text).css_first(".js-add-to-calendar[data-share]")
    try:
        share = json.loads(node.attributes.get("data-share") or "") if node is not None else {}
    except json.JSONDecodeError:
        return False
    start, end = _share_time(share.get("start")), _share_time(share.get("end"))
    if start is None:
        return False
    if end is not None and end < start:
        end += timedelta(days=1)  # "23:30" to "4:00" on the same date: the next morning
    event.start = event.doors = start
    event.end = end
    return True


def _share_time(value: object) -> datetime | None:
    """ "2026-09-27 19:30:00" or, unpadded, "2026-09-26 4:00:00"."""
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2}) (\d{1,2}:\d{2})(?::\d{2})?", str(value or ""))
    return combine(date(int(m[1]), int(m[2]), int(m[3])), m[4]) if m else None
