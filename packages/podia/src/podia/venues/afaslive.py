"""AFAS Live, Amsterdam-Zuidoost (the former Heineken Music Hall). Reads the agenda page
and, through `details()`, each event's own page.

The site (Craft CMS, run by Live Nation / Mojo) has no feed, JSON-LD or API, so this
reads HTML. The agenda (`afaslive.nl/agenda`, one page) lists every upcoming show as an
`article#_agenda_<id>`: title, date ("vrijdag 06 november 2026"), poster, the main
ticket link and a status class (`st-soldout`, `st-canceled`, `st-moved`). A show with
several performances is one article per performance sharing the id; the listing shows
the time only when there are two on one day (`<h4>B-Brave <time>15:00</time></h4>`). A
rescheduled show ("Verplaatst!") keeps the old date struck through beside the new one.
The venue gives no genres or event types: comedy, talks, children's shows and dance
events are listed like the concerts.

`details()` reads the event page: the tour name (`h2 small`), support acts, door and
start times ("Deuren open 18:30 uur", "Aanvang 20:00 uur"), prices per ticket type and
the description. A page with several performances has a ticket block (`<details>`) and a
timetable tab per performance; the one matching the event's date and time is used.

`capacity` is the Black Box's maximum, 6,000, from the venue's technical rider
(afaslive.nl/files/Overige/Rider-AFAS-Live-april-2022.pdf).
"""

from __future__ import annotations

import copy
import re
from collections import Counter
from collections.abc import Iterator
from datetime import date

from selectolax.parser import HTMLParser, Node

from podia.extract import clean, combine, mask_emails, month_number, node_text, site_url
from podia.http import Fetcher
from podia.model import Availability, Event, Price, Status, VenueInfo
from podia.venue import FetchOptions, Venue, register

BASE = "https://www.afaslive.nl"
AGENDA = f"{BASE}/agenda"
_DATE = re.compile(r"(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})", re.I)
_SHORT_DATE = re.compile(r"(\d{1,2})\s+([a-z]+)\.?", re.I)
_CLOCK = re.compile(r"\b(\d{1,2})[:.](\d{2})\b")
_AMOUNT = re.compile(r"€\s*(\d+(?:[.,]\d{1,2})?)")
STATUS = {"st-canceled": Status.CANCELLED, "st-moved": Status.POSTPONED}


@register
class AfasLive(Venue):
    info = VenueInfo(
        slug="afaslive", name="AFAS Live", city="Amsterdam", website=BASE, capacity=6000
    )
    has_details = True

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        r = fetch.get(AGENDA)
        r.raise_for_status()
        events = [
            e
            for e in map(self._item, HTMLParser(r.text).css("article.agendaV2-item"))
            if e is not None and e.start.date() >= options.since
        ]
        # Performances share the show's id; the day tells them apart, and the time when
        # there are two on one day.
        days = Counter(e.source_id for e in events)
        for e in events:
            if days[e.source_id] > 1 and e.extra.get("time_known", True):
                e.source_id += e.start.strftime("-%H%M")
        yield from events

    def details(self, fetch: Fetcher, event: Event) -> Event:
        if not event.url:
            return event
        r = fetch.get(event.url)
        r.raise_for_status()
        page = HTMLParser(r.text).css_first("div.agenda-item")
        if page is None:
            return event
        e = copy.deepcopy(event)
        heading = page.css_first("h2 small")
        e.subtitle = e.subtitle or node_text(heading)
        if not e.support:
            e.support = _support(page)
        if not e.description:
            parts = [node_text(n) for n in page.css(".floated.intro, .agendaInfo .txt")]
            e.description = "\n\n".join(p for p in parts if p) or None

        block = _matching(page.css(".floated.dates details"), e)
        if block is not None:
            when = node_text(block.css_first("datetime"))
            clock = _CLOCK.search(when or "")
            if clock and not e.extra.get("time_known", True):
                e.start = combine(e.start.date(), clock[0])
                e.extra["time_known"] = True
            e.price = e.price or _price(block)
            ticket = block.css_first("a.button.first")
            e.ticket_url = e.ticket_url or _http(ticket.attributes.get("href") if ticket else None)
            info = node_text(block.css_first("summary .info")) or ""
            if "geannuleerd" in info.lower():
                e.status = Status.CANCELLED

        times = _times(page, e, single=len(page.css(".floated.dates details")) == 1)
        if "aanvang" in times and not e.extra.get("time_known", True):
            e.start = combine(e.start.date(), times["aanvang"])
            e.extra["time_known"] = True
        if "deuren open" in times and e.doors is None:
            e.doors = combine(e.start.date(), times["deuren open"])
        return e

    def _item(self, article: Node) -> Event | None:
        m = re.fullmatch(r"_agenda_(\d+)", article.attributes.get("id") or "")
        link = article.css_first("a.rowMain")
        heading = link.css_first("h4") if link is not None else None
        if not m or link is None or heading is None:
            return None
        clock_node = heading.css_first("time")
        clock = node_text(clock_node)
        if clock_node is not None:
            clock_node.decompose()
        title = node_text(heading)
        current = [n for n in link.css("p.date span.d") if "strike" not in _classes(n)]
        struck = [n for n in link.css("p.date span.d.strike")]
        day = _day(node_text((current or struck or [None])[-1]))
        if not title or day is None:
            return None

        classes = _classes(article)
        status = next((s for c, s in STATUS.items() if c in classes), Status.SCHEDULED)
        extra: dict[str, object] = {}
        if not (clock and _CLOCK.search(clock)):
            clock = None
            extra["time_known"] = False
        if current and struck:
            moved_from = _day(node_text(struck[-1]))
            if moved_from is not None:
                extra["moved_from"] = moved_from.isoformat()
        image = article.css_first(".rowImg img")
        ticket = article.css_first("a.btnV2.tickets")
        return Event(
            venue=self.info.slug,
            source_id=f"{m[1]}-{day.isoformat()}",
            title=title,
            start=combine(day, clock),
            url=site_url(BASE, link.attributes.get("href")),
            city=self.info.city,
            status=status,
            availability=Availability.SOLD_OUT if "st-soldout" in classes else Availability.UNKNOWN,
            ticket_url=_http(ticket.attributes.get("href") if ticket else None),
            image=_http(image.attributes.get("src") if image else None),
            extra=extra,
        )

    def redact(self, url: str, text: str) -> str:
        """Agenda: only the list of shows. Event page: only the event block, without
        scripts, embeds, share links and the Sky Lounge advert. The template's deep
        indentation goes too."""
        tree = HTMLParser(text)
        node = tree.css_first("div.agendaV2-list" if url == AGENDA else "div.agenda-item")
        if node is None:
            return mask_emails(text)
        for junk in node.css("script, style, svg, iframe, .social-share, .skylounge-promo"):
            junk.decompose()
        return mask_emails(re.sub(r"\s*\n\s*", "\n", node.html or ""))


def _classes(node: Node) -> set[str]:
    return set((node.attributes.get("class") or "").split())


def _http(url: str | None) -> str | None:
    url = clean(url)
    return url if url and url.startswith(("https://", "http://")) else None


def _day(text: str | None) -> date | None:
    """ "vrijdag 06 november 2026", "zaterdag, 07 november 2026"."""
    m = _DATE.search(text or "")
    if not m:
        return None
    try:
        return date(int(m[3]), month_number(m[2]), int(m[1]))
    except (KeyError, ValueError):
        return None


def _support(page: Node) -> list[str]:
    acts = []
    for li in page.css("ul.act li"):
        text = node_text(li) or ""
        name = re.sub(r"^\s*support\s*(?:act)?s?\s*:?\s*", "", text, flags=re.I)
        if name and name != text:
            acts.append(name)
    return acts


def _matching(blocks: list[Node], e: Event) -> Node | None:
    """The ticket block for the event's performance: same day, and same time when the
    block and the event both have one."""
    for block in blocks:
        when = node_text(block.css_first("datetime"))
        if _day(when) != e.start.date():
            continue
        clock = _CLOCK.search(when or "")
        if clock and e.extra.get("time_known", True) and clock[0] != e.start.strftime("%H:%M"):
            continue
        return block
    return None


def _price(block: Node) -> Price | None:
    """ "Staanplaats € 59,-", "Entree vanaf € 51,61": the range over ticket types, with the
    venue's own lines as the text."""
    lines, amounts = [], []
    for li in block.css("ul li"):
        text = node_text(li)
        if not text:
            continue
        lines.append(text)
        amounts += [float(a.replace(",", ".")) for a in _AMOUNT.findall(text)]
    if not lines:
        return None
    if not amounts:
        return Price(text="; ".join(lines))
    return Price(min(amounts), max(amounts), "; ".join(lines))


def _times(page: Node, e: Event, single: bool) -> dict[str, str]:
    """{"deuren open": "18:30", "aanvang": "20:00"} for the event's performance: the
    page's own list when it has one performance, else the matching timetable tab."""
    lists: list[Node] = []
    if single:
        lists = page.css("ul.timesTable")
    for button in page.css("#timetable button[data-tab]"):
        label = node_text(button) or ""
        m = _SHORT_DATE.search(label)
        if not m:
            continue
        try:
            if (int(m[1]), month_number(m[2])) != (e.start.day, e.start.month):
                continue
        except KeyError:
            continue
        clock = _CLOCK.search(label)
        if clock and e.extra.get("time_known", True) and clock[0] != e.start.strftime("%H:%M"):
            continue
        tab = page.css_first(f"#{button.attributes.get('data-tab')}")
        if tab is not None:
            lists = tab.css("ul") + lists
        break
    found: dict[str, str] = {}
    for ul in lists:
        for li in ul.css("li"):
            text = (node_text(li) or "").lower()
            clock = _CLOCK.search(text)
            if not clock:
                continue
            for label in ("deuren open", "aanvang"):
                if text.startswith(label):
                    found.setdefault(label, clock[0])
    return found
