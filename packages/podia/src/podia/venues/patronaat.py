"""Patronaat, Haarlem. Reads the public event-info XML API, plus the programme page for
sold-out flags.

The API lists every event in one response: name, subtitle, description, start and end,
genres, an internal event type, support acts, ticket link and price. It also lists shows
Patronaat promotes elsewhere (PHIL, Doopsgezind Haarlem, Sint Bavokerk); only those at
`location` "Patronaat" are kept. It has no room and no sale status, so "UITVERKOCHT" and
"LAATSTE KAARTEN" come from the tags on /programma/, matched by event URL. Cancellations
and postponements are only stated as a prefix on the name ("AFGELAST: …").
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from collections.abc import Iterator
from datetime import datetime, timedelta

from selectolax.parser import HTMLParser

from podia.extract import clean, combine, strip_tags
from podia.http import Fetcher
from podia.model import Availability, Event, Price, Status, VenueInfo
from podia.venue import FetchOptions, Venue, register

API = "https://patronaat.nl/api/event-info/v1/events-detailed"
PROGRAMME = "https://patronaat.nl/programma/"
OWN_LOCATION = "Patronaat"
FIXTURE_EVENTS = 40

_STATUS_PREFIX = [
    (re.compile(r"^(afgelast|geannuleerd)\b", re.I), Status.CANCELLED),
    (re.compile(r"^verplaatst\b", re.I), Status.POSTPONED),
]
_SALE_TAGS = {"is_sold_out": Availability.SOLD_OUT, "last_tickets": Availability.FEW_LEFT}
_SIZED_IMAGE = re.compile(r"-\d+x\d+\.\w+$")


@register
class Patronaat(Venue):
    info = VenueInfo(
        slug="patronaat", name="Patronaat", city="Haarlem", website="https://patronaat.nl"
    )

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        r = fetch.get(API)
        r.raise_for_status()
        root = ET.fromstring(r.text)
        sale = _sale_tags(fetch)
        for item in root.iter("event"):
            if clean(item.findtext("location")) != OWN_LOCATION:
                continue
            title = clean(item.findtext("name")) or ""
            url = clean(item.findtext("link"))
            yield Event(
                venue=self.info.slug,
                source_id=item.findtext("event_id") or url or title,
                title=title,
                subtitle=clean(item.findtext("subtitle")),
                start=(start := _when(item.find("start"))),
                end=_end(start, item.find("end")),
                url=url,
                city=self.info.city,
                support=[
                    name
                    for act in item.iterfind("support_acts/act")
                    if (name := clean(act.findtext("name")))
                ],
                genres=[g for node in item.iterfind("genres/genre") if (g := clean(node.text))],
                categories=_categories(item.findtext("event_type")),
                status=_status(title),
                availability=sale.get(url or "", Availability.UNKNOWN),
                price=_price(item.findtext("ticket_price")),
                ticket_url=clean(item.findtext("ticket_url")),
                description=strip_tags(item.findtext("description")),
                image=_image([i.text or "" for i in item.iterfind("images/image")]),
                extra={
                    "yesplan_id": item.findtext("yesplan_id"),
                    "type": item.findtext("event_type"),
                },
            )

    def redact(self, url: str, text: str) -> str:
        if url == API:
            # Keep the first events, one full-size image each and no media links.
            root = ET.fromstring(text)
            for item in list(root)[FIXTURE_EVENTS:]:
                root.remove(item)
            for item in root:
                for media in item.findall("media"):
                    item.remove(media)
                images = item.find("images")
                if images is not None:
                    keep = _image([i.text or "" for i in images])
                    for image in list(images):
                        if image.text != keep:
                            images.remove(image)
            return ET.tostring(root, encoding="unicode")
        if url == PROGRAMME:
            # Only the event links and their sale tags.
            rows = [
                f'<div class="event-program"><a class="event-program__name" href="{href}"></a>'
                f'<div class="event-program__status-tag {tag}"></div></div>'
                for href, tag in _programme_tags(text)
            ]
            return "<html><body>\n" + "\n".join(rows) + "\n</body></html>\n"
        return text


def _when(node: ET.Element | None) -> datetime:
    if node is None:
        raise ValueError("event without a start")
    day = datetime.strptime(node.findtext("date") or "", "%Y%m%d").date()
    return combine(day, node.findtext("time"))


def _end(start: datetime, node: ET.Element | None) -> datetime | None:
    # Night events keep the start date on an end time after midnight ("23:00" to "03:00").
    # An end at or before the start otherwise is a placeholder, so it is dropped.
    if node is None:
        return None
    end = _when(node)
    if end < start:
        end += timedelta(days=1)
    return end if timedelta(0) < end - start <= timedelta(hours=14) else None


def _categories(event_type: str | None) -> list[str]:
    # "Verhuur openbaar (concert)" and "Co-creator (dance)" are internal deal types; the
    # part in brackets is the kind of event. The raw value stays in `extra`.
    event_type = clean(event_type)
    if not event_type:
        return []
    m = re.search(r"\(([^)]+)\)", event_type)
    kind = m[1] if m else event_type
    return [kind[:1].upper() + kind[1:]]


def _status(title: str) -> Status:
    for pattern, status in _STATUS_PREFIX:
        if pattern.match(title):
            return status
    return Status.SCHEDULED


def _price(text: str | None) -> Price | None:
    text = clean(text)
    if not text:
        return None
    try:
        amount = float(text)
    except ValueError:
        return Price(text=text)
    return Price(amount, amount, None)


def _image(urls: list[str]) -> str | None:
    """The original upload: the first URL without a WordPress "-WxH" size suffix."""
    urls = [u.strip() for u in urls if u.strip()]
    for u in urls:
        if not _SIZED_IMAGE.search(u):
            return u
    return urls[-1] if urls else None


def _sale_tags(fetch: Fetcher) -> dict[str, Availability]:
    r = fetch.get(PROGRAMME)
    if r.status >= 400:  # sale tags are a bonus; the API alone is enough
        return {}
    return {href: _SALE_TAGS[tag] for href, tag in _programme_tags(r.text) if tag in _SALE_TAGS}


def _programme_tags(page: str) -> Iterator[tuple[str, str]]:
    """(event URL, status tag class) for each tagged event on the programme page."""
    for card in HTMLParser(page).css("div.event-program"):
        link = card.css_first(".event-program__name a, a.event-program__name")
        tag = card.css_first(".event-program__status-tag")
        if link is None or tag is None:
            continue
        classes = (tag.attributes.get("class") or "").split()
        for cls in classes:
            if cls != "event-program__status-tag":
                yield link.attributes.get("href") or "", cls
