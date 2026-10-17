"""P60, Amstelveen. Reads the theme's own REST endpoint, the WordPress REST API for genres,
and, through `details()`, each event's page.

`/wp-json/p60/v1/posts` returns every upcoming programmed event in one response (it takes
no paging or date parameters): title, subtitle, descriptions, poster, and a `shows` record
with date, time, presale price and sold-out / cancelled flags. Its time is when the hall
opens ("Zaal Open" on the event page), so it becomes both start and doors here, as on
Bitterzoet's listing. The café's own nights (pub quizzes, karaoke, jam sessions) aren't
in it. Its `endTime` is mostly the CMS's default (23:55 or 23:59, on the same day), so
only other end times are kept.

The genres ("Rock", "Cover / Tribute", "Club / Dance"…) are the `eventtype` taxonomy and
the production type ("Productie", "Verhuur") the `type` taxonomy, both only in the
standard REST API (`/wp/v2/agenda_item`, asked for the listed ids in one call) along with
the event page's link; the term names come from `/wp/v2/eventtype` and `/wp/v2/type`.
The theme endpoint's own `categories` ("concerten") are kept as categories.

`details()` reads the event page's info block, a run of Elementor headings: the price
tiers ("Voorverkoop", "Avondkassa", "Early bird", "VIP 1"… each followed by "€ 26,50"),
then "Zaal Open" and a timetable of labels and times ("Show"; or "Support (tba)", "MDB";
"Deuren dicht"), kept in `extra["timetable"]`, and the ticket button (Ticketmaster,
Weezevent…). The start becomes the "Show" time, else the timetable's first act.
"""

from __future__ import annotations

import copy
import json
import re
from collections.abc import Iterator
from datetime import date, datetime, timedelta
from typing import Any

from selectolax.parser import HTMLParser

from podia.extract import clean, combine, mask_emails, node_text, site_url
from podia.http import Fetcher
from podia.model import Availability, Event, Price, Status, VenueInfo
from podia.venue import FetchOptions, Venue, register

BASE = "https://p60.nl"
POSTS = f"{BASE}/wp-json/p60/v1/posts"
API = f"{BASE}/wp-json/wp/v2"
ITEMS = f"{API}/agenda_item"
TERMS = {"eventtype": f"{API}/eventtype", "type": f"{API}/type"}
PAGE_SIZE = 100  # ids per REST call, the API's maximum
# The CMS fills in these end times when nobody set one.
DEFAULT_END_TIMES = {"23:55", "23:59"}
_DAY = re.compile(r"(\d{1,2})-(\d{1,2})-(\d{4})")
_CLOCK = re.compile(r"^\d{1,2}[:.]\d{2}\b")
_AMOUNT = re.compile(r"€\s*(\d+(?:[.,]\d{1,2})?)")
# The info block ends where the page's general visitor information begins.
_INFO_END = "extra informatie"
_NOT_STARTS = {"deuren dicht", "einde", "eind", "curfew"}


@register
class P60(Venue):
    info = VenueInfo(slug="p60", name="P60", city="Amstelveen", website=BASE)
    has_details = True

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        r = fetch.get(POSTS)
        r.raise_for_status()
        posts = [p for p in r.json() if isinstance(p, dict) and p.get("id")]
        items = _items(fetch, [p["id"] for p in posts])
        names = {taxonomy: _terms(fetch, url) for taxonomy, url in TERMS.items()}
        events = []
        for post in posts:
            for event in self._events(post, items.get(post["id"], {}), names):
                if event.start.date() >= options.since:
                    events.append(event)
        yield from sorted(events, key=lambda e: (e.start, e.source_id))

    def _events(
        self, post: dict[str, Any], item: dict[str, Any], names: dict[str, dict[int, str]]
    ) -> Iterator[Event]:
        title = clean(post.get("title"))
        if not title:
            return
        shows = post.get("shows")
        shows = (
            [shows] if isinstance(shows, dict) else [s for s in shows or [] if isinstance(s, dict)]
        )
        url = site_url(BASE, item.get("link")) or site_url(BASE, _first(shows, "ticketUrl"))
        genres = [
            names["eventtype"][t] for t in item.get("eventtype", []) if t in names["eventtype"]
        ]
        production = [names["type"][t] for t in item.get("type", []) if t in names["type"]]
        categories = [
            c for c in (clean(c) for c in str(post.get("categories") or "").split(",")) if c
        ]
        for show in shows:
            day = _day(show.get("startDate"))
            clock = clean(show.get("startTime"))
            if day is None:
                continue
            start = combine(day, clock)
            end_day, end_clock = _day(show.get("endDate")), clean(show.get("endTime"))
            end = (
                combine(end_day, end_clock)
                if end_day and end_clock and end_clock not in DEFAULT_END_TIMES
                else None
            )
            price = _price(show.get("price"))
            sold_out = str(show.get("soldOut") or "0") == "1"
            cancelled = str(show.get("cancelled") or "0") == "1"
            yield Event(
                venue=self.info.slug,
                source_id=str(post["id"]) if len(shows) == 1 else f"{post['id']}-{day.isoformat()}",
                title=title,
                start=start,
                url=url,
                subtitle=clean(post.get("subtitle")),
                # The listed time is when the hall opens ("Zaal Open"); details() has the show.
                doors=start if clock else None,
                end=end if end and end > start else None,
                city=self.info.city,
                genres=genres,
                categories=categories,
                status=Status.CANCELLED if cancelled else Status.SCHEDULED,
                availability=Availability.SOLD_OUT if sold_out else Availability.UNKNOWN,
                price=price,
                description=_description(post),
                image=site_url(BASE, post.get("image")),
                extra={"production": production} if production else {},
            )

    def details(self, fetch: Fetcher, event: Event) -> Event:
        if not event.url:
            return event
        r = fetch.get(event.url)
        r.raise_for_status()
        tree = HTMLParser(r.text)
        headings = _info_headings(tree)
        detailed = copy.deepcopy(event)
        labels = [h.lower() for h in headings]
        opens = labels.index("zaal open") if "zaal open" in labels else len(headings)
        amounts = [
            float(m[1].replace(",", ".")) for h in headings[:opens] if (m := _AMOUNT.fullmatch(h))
        ]
        if amounts:
            detailed.price = Price(min(amounts), max(amounts), None)
        doors, timetable = _times(headings[opens:], event.start.date())
        if doors is not None:
            detailed.doors = doors
        if timetable:
            detailed.extra["timetable"] = [[label, t.strftime("%H:%M")] for label, t in timetable]
        start = _show_start(timetable)
        if start is not None and (detailed.doors is None or start >= detailed.doors):
            detailed.start = start
        if ticket_url := _ticket_url(tree):
            detailed.ticket_url = ticket_url
            if detailed.availability is Availability.UNKNOWN and event.status is Status.SCHEDULED:
                detailed.availability = Availability.ON_SALE
        if detailed.end is not None and detailed.end <= detailed.start:
            detailed.start = event.start  # a show time past the listed end: keep the listing's
        return detailed

    def redact(self, url: str, text: str) -> str:
        """Theme endpoint: only the fields read here. Event pages: only the info block's
        headings and the ticket button."""
        if url == POSTS:
            keep = ("id", "title", "subtitle", "shortdescription", "longdescription", "categories",
                    "image", "shows")  # fmt: skip
            posts = [{k: p[k] for k in keep if k in p} for p in json.loads(text)]
            return mask_emails(json.dumps(posts, ensure_ascii=False, indent=1))
        if url.startswith(f"{BASE}/") and "/wp-json/" not in url:
            tree = HTMLParser(text)
            parts = [f'<h2 class="elementor-heading-title">{h}</h2>' for h in _info_headings(tree)]
            if ticket := _ticket_url(tree):
                parts.append(f'<a class="elementor-button" href="{ticket}">tickets</a>')
            return mask_emails("\n".join(parts))
        return text


def _items(fetch: Fetcher, ids: list[int]) -> dict[int, dict[str, Any]]:
    """Post id → its REST record (link, eventtype and type term ids)."""
    items: dict[int, dict[str, Any]] = {}
    for i in range(0, len(ids), PAGE_SIZE):
        params = {
            "include": ",".join(str(x) for x in ids[i : i + PAGE_SIZE]),
            "per_page": str(PAGE_SIZE),
            "_fields": "id,link,eventtype,type",
        }
        r = fetch.get(ITEMS, params=params)
        r.raise_for_status()
        items.update({item["id"]: item for item in r.json()})
    return items


def _terms(fetch: Fetcher, url: str) -> dict[int, str]:
    """Term id → name, e.g. {61: "Rock", 52: "Club / Dance"}."""
    r = fetch.get(url, params={"per_page": "100", "_fields": "id,name"})
    r.raise_for_status()
    return {t["id"]: name for t in r.json() if (name := clean(t.get("name")))}


def _first(shows: list[dict[str, Any]], key: str) -> str | None:
    return next((s[key] for s in shows if s.get(key)), None)


def _day(value: Any) -> date | None:
    """ "03-12-2026" (day-month-year)."""
    m = _DAY.fullmatch(str(value or "").strip())
    if not m:
        return None
    try:
        return date(int(m[3]), int(m[2]), int(m[1]))
    except ValueError:
        return None


def _price(value: Any) -> Price | None:
    """The presale price, "26,50" or "60"; empty when there is none."""
    text = clean(str(value or ""))
    if not text:
        return None
    if re.fullmatch(r"\d+(?:[.,]\d{1,2})?", text):
        amount = float(text.replace(",", "."))
        return Price(amount, amount, None)
    return Price(text=text)


def _description(post: dict[str, Any]) -> str | None:
    """The long description, which repeats the short one and runs on into the rest
    without a space ("…kan zijn!Een Jett Rebel-show…")."""
    short = (post.get("shortdescription") or "").strip()
    text = (post.get("longdescription") or "").strip()
    if short and text.startswith(short):
        text = f"{short} {text[len(short) :]}"
    return clean(text or short)


def _info_headings(tree: HTMLParser) -> list[str]:
    """The info block's headings in page order: title, subtitle, price tiers, times. They
    stop at "Extra informatie", where the general visitor information starts."""
    headings = []
    for node in tree.css(".elementor-heading-title"):
        text = node_text(node)
        if not text:
            continue
        if text.lower() == _INFO_END:
            break
        headings.append(text)
    return headings


def _times(headings: list[str], day: date) -> tuple[datetime | None, list[tuple[str, datetime]]]:
    """From "Zaal Open", "20:00 uur", "Support (tba)", "20:30 uur", "MDB", "21:15 uur"…:
    the doors and the label-time pairs after them. A time earlier than the doors is after
    midnight ("Deuren dicht", "00:30 uur")."""
    pairs = []
    for label, value in zip(headings[::2], headings[1::2], strict=False):
        if not _CLOCK.match(value):
            break
        pairs.append((label, combine(day, value)))
    if not pairs or pairs[0][0].lower() != "zaal open":
        return None, []
    doors = pairs[0][1]
    timetable = [(label, t + timedelta(days=1) if t < doors else t) for label, t in pairs[1:]]
    return doors, timetable


def _show_start(timetable: list[tuple[str, datetime]]) -> datetime | None:
    """The time labelled "Show", else the first act's ("Support (tba)", "Start MOKKA!");
    "Deuren dicht" (doors close) is no start."""
    for label, t in timetable:
        if label.lower() == "show":
            return t
    return next((t for label, t in timetable if label.lower() not in _NOT_STARTS), None)


def _ticket_url(tree: HTMLParser) -> str | None:
    """The ticket button: the first Elementor button leading off the site."""
    for a in tree.css("a.elementor-button[href]"):
        href = (a.attributes.get("href") or "").strip()
        if re.match(r"https?://", href) and not re.match(r"https?://(www\.)?p60\.nl(/|$)", href):
            return href
    return None
