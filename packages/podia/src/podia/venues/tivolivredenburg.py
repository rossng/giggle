"""TivoliVredenburg, Utrecht. Reads the WordPress agenda RSS feed.

The site itself sits behind a bot challenge, but `/agenda/feed/?paged=N` is open and each
item's `content:encoded` holds the venue's full production record as JSON: times, rooms,
genres, ticket status and prices, support act, line-up. WordPress wraps it in `<p>` tags
and swaps emoji for `<img>` tags, which are undone before parsing; an item that still
doesn't parse is skipped and logged.

The feed is ordered by event date from today onwards, 10 items a page, and a page past
the end is a 404. The record's `startDatetime` is the door time; the show start and the
expected end come from the timings marked for the website.

Records also carry internal data (crew timings, sales figures, early-access codes); only
the fields in `_public` are read, and fixtures are rebuilt from those alone.
"""

from __future__ import annotations

import json
import logging
import re
import xml.etree.ElementTree as ET
from collections.abc import Iterator
from datetime import datetime
from typing import Any

from podia.extract import clean, parse_iso, strip_tags
from podia.http import Fetcher
from podia.model import Availability, Event, Price, Status, VenueInfo
from podia.venue import FetchOptions, Venue, register

log = logging.getLogger(__name__)

FEED = "https://www.tivolivredenburg.nl/agenda/feed/"
CONTENT = "{http://purl.org/rss/1.0/modules/content/}encoded"

# Program locations that aren't rooms in the building.
ELSEWHERE = {"Buitenwereld", "Online"}

STATUS = {"Cancelled": Status.CANCELLED, "Moved": Status.MOVED}
AVAILABILITY = {
    "For sale": Availability.ON_SALE,
    "Last tickets": Availability.FEW_LEFT,
    "Sold out": Availability.SOLD_OUT,
    "Free": Availability.FREE,
}

# Plain record fields that are read; lists and nested ones are filtered in `_public`.
PUBLIC = (
    "id",
    "publicTitle",
    "subTitle",
    "startDatetime",
    "programLocations",
    "category",
    "ticketStatus",
    "ticketStatusOverride",
    "hidePriceDetails",
    "priceOverride",
    "useFastSkinUrl",
    "tixlySkinUrl",
    "tixlyFastSkinUrl",
    "externalTicketLink",
    "performer",
    "supportAct",
    "mainContent",
    "age",
)

_EMOJI = re.compile(r'<img [^>]*?alt="([^"]*)"[^>]*>')
_NO_SUPPORT = re.compile(r"^(geen\b.*|nog niet bekend|n\.?v\.?t\.?|t\.?b\.?a\.?)$", re.I)


@register
class TivoliVredenburg(Venue):
    info = VenueInfo(
        slug="tivolivredenburg",
        name="TivoliVredenburg",
        city="Utrecht",
        website="https://www.tivolivredenburg.nl",
    )

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        page = 1
        while options.max_pages is None or page <= options.max_pages:
            r = fetch.get(FEED, params={"paged": page})
            if r.status == 404:  # past the last page
                break
            r.raise_for_status()
            items = _items(r.text)
            if not items:
                break
            skipped = 0
            for link, record in items:
                if record is None:
                    skipped += 1
                    continue
                event = self._event(link, record)
                if event is not None and event.start.date() >= options.since:
                    yield event
            if skipped:
                log.warning("tivolivredenburg: page %d: %d unparsable items skipped", page, skipped)
            page += 1

    def redact(self, url: str, text: str) -> str:
        # Rebuild the feed from each record's public fields only.
        rss = ET.Element("rss", version="2.0")
        channel = ET.SubElement(rss, "channel")
        for link, record in _items(text):
            item = ET.SubElement(channel, "item")
            ET.SubElement(item, "link").text = link
            body = json.dumps({"production": record}, ensure_ascii=False) if record else "?"
            ET.SubElement(item, CONTENT).text = f"<p>{body}</p>"
        return ET.tostring(rss, encoding="unicode") + "\n"

    def _event(self, link: str | None, p: dict[str, Any]) -> Event | None:
        rooms = [r for r in (p["programLocations"] or "").split(";") if r]
        if any(r in ELSEWHERE for r in rooms):
            return None
        doors = parse_iso(p["startDatetime"])
        starts = _timings(p, "Start")
        ends = _timings(p, "Expected end time")
        start = starts[0] if starts else doors
        if start is None:
            return None
        ticket_status = p["ticketStatusOverride"] or p["ticketStatus"]
        return Event(
            venue=self.info.slug,
            source_id=p["id"],
            title=clean(p["publicTitle"]) or "",
            subtitle=clean(p["subTitle"]),
            start=start,
            doors=doors if doors and doors <= start else None,
            end=ends[-1] if ends and ends[-1] > start else None,
            url=link,
            room=", ".join(dict.fromkeys(rooms)) or None,
            city=self.info.city,
            performers=_performers(p["performer"]),
            support=_support(p["supportAct"]),
            genres=list(dict.fromkeys(g["name"] for g in p["subGenres"])),
            categories=[p["category"]] if p["category"] else [],
            status=STATUS.get(ticket_status, Status.SCHEDULED),
            availability=AVAILABILITY.get(ticket_status, Availability.UNKNOWN),
            price=_price(p),
            ticket_url=_ticket_url(p),
            description=strip_tags(p["mainContent"]),
            image=p["defaultDigitalAsset"]["urls"]["landscape_large"],
            extra={"age": p["age"]} if p["age"] else {},
        )


def _items(feed: str) -> list[tuple[str | None, dict[str, Any] | None]]:
    """(link, public record) for each feed item; the record is None if it doesn't parse."""
    root = ET.fromstring(feed)
    items = []
    for item in root.iter("item"):
        items.append((item.findtext("link"), _record(item.findtext(CONTENT) or "")))
    return items


def _record(content: str) -> dict[str, Any] | None:
    if "{" not in content:
        return None
    text = content[content.index("{") : content.rindex("}") + 1]
    text = _EMOJI.sub(r"\1", re.sub(r"</?p>", "", text))
    try:
        production = json.loads(text, strict=False)["production"]
    except (json.JSONDecodeError, KeyError, TypeError):
        return None
    return _public(production)


def _public(p: dict[str, Any]) -> dict[str, Any]:
    """The record reduced to the fields this adapter reads, in the same shape (so it can be
    applied again to a fixture). Internal data (crew timings, sales figures, access codes,
    hidden prices) is left behind."""
    record = {key: p.get(key) for key in PUBLIC}
    record["timings"] = [
        {"timingType": t.get("timingType"), "timing": t["timing"], "showOnWebsite": True}
        for t in p.get("timings") or []
        if t.get("showOnWebsite") and not t.get("isDeleted") and t.get("timing")
    ]
    record["subGenres"] = [
        {"name": g["name"], "showOnWebsite": True}
        for g in p.get("subGenres") or []
        if g.get("showOnWebsite") and not g.get("isDeleted")
    ]
    record["ticketTypes"] = [
        {"ticketTypePrices": [{"price": tp["price"], "showOnWebsite": True} for tp in prices]}
        for tt in p.get("ticketTypes") or []
        if not tt.get("isDeleted")
        and (
            prices := [
                tp
                for tp in tt.get("ticketTypePrices") or []
                if tp.get("showOnWebsite")
                and not tp.get("isDeleted")
                and tp.get("price") is not None
            ]
        )
    ]
    image = ((p.get("defaultDigitalAsset") or {}).get("urls") or {}).get("landscape_large")
    record["defaultDigitalAsset"] = {"urls": {"landscape_large": image}}
    return record


def _timings(p: dict[str, Any], kind: str) -> list[datetime]:
    return sorted(parse_iso(t["timing"]) for t in p["timings"] if t["timingType"] == kind)


def _performers(fragment: str | None) -> list[str]:
    # The line-up field bolds each name: "<b>Kika Sprangers</b> saxofoon".
    names = (clean(strip_tags(n)) for n in re.findall(r"<b>(.*?)</b>", fragment or "", re.S))
    return list(dict.fromkeys(n.strip(" ,") for n in names if n and n.strip(" ,")))


def _support(fragment: str | None) -> list[str]:
    if not fragment:
        return []
    lines = re.split(r"<br\s*/?>|</div>|\n", fragment)
    acts = (clean(strip_tags(line)) for line in lines)
    return [a for a in acts if a and not _NO_SUPPORT.match(a)]


def _ticket_url(p: dict[str, Any]) -> str | None:
    if p["externalTicketLink"]:
        return p["externalTicketLink"]
    if p["useFastSkinUrl"] and p["tixlyFastSkinUrl"]:
        return p["tixlyFastSkinUrl"]
    return p["tixlySkinUrl"] or None


def _price(p: dict[str, Any]) -> Price | None:
    if p["hidePriceDetails"]:
        return None
    amounts = [float(tp["price"]) for tt in p["ticketTypes"] for tp in tt["ticketTypePrices"]]
    if p["priceOverride"] is not None:
        amounts.append(float(p["priceOverride"]))
    if not amounts:
        return None
    return Price(min(amounts), max(amounts))
