"""Bimhuis, Amsterdam. Reads the public WPGraphQL API behind the Next.js site.

Every event exists twice, once per language; this adapter asks for the Dutch ones only.
Each event has one or more `times` with doors, start, end, room ("Zaal", "Café"), prices
by seat type, a sale status and a ticket link. Events co-presented next door at the
Muziekgebouw are listed too and left out.

Bimhuis tags events in three ways. `filters` is its genre list (Free Jazz,
Straight-Ahead…), but no upcoming event uses it at the moment. `specials` are programme
series, mostly by style (Impro Focus, Latin Jazz, Vocal Jazz, also Headliners and BIG);
these go into `genres`. `tags` are formats and festivals (Dubbelconcert,
Albumpresentatie, Cello Biënnale); these go into `categories`.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime
from typing import Any

from podia.extract import clean, local, strip_tags
from podia.http import Fetcher
from podia.model import Availability, Event, Price, Status, VenueInfo
from podia.venue import FetchOptions, Venue, register

API = "https://backend.bimhuis.nl/wp/graphql"
PAGE_SIZE = 50  # the API fails on 100
OWN_ROOMS = {"Zaal", "Café", "Bimhuis"}  # "Bimhuis" is used when no room is given

QUERY = """
query Agenda($first: Int!, $after: String) {
  events(first: $first, after: $after, where: {language: NL, timeframe: CURRENT}) {
    pageInfo { hasNextPage endCursor }
    nodes {
      databaseId title link
      featuredImage { node { sourceUrl } }
      eventData { excerpt }
      filters { nodes { name } }
      specials { nodes { name } }
      tags { nodes { name } }
      ticketsData { externalLocation externalTicketUrl isLastTickets }
      times {
        event_id location door_open program_start program_end program_end_visible
        status status_label ticket_link tickets_free
        price { normal price }
      }
    }
  }
}
"""

_SALE_STATUS = {
    "tickets": Availability.ON_SALE,
    "free": Availability.FREE,
    "sold-out": Availability.SOLD_OUT,
}
_EVENT_STATUS = {
    "cancelled": Status.CANCELLED,
    "afgelast": Status.CANCELLED,
    "postponed": Status.POSTPONED,
    "uitgesteld": Status.POSTPONED,
    "verplaatst": Status.POSTPONED,
}


@register
class Bimhuis(Venue):
    info = VenueInfo(
        slug="bimhuis", name="Bimhuis", city="Amsterdam", website="https://www.bimhuis.nl"
    )

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        after: str | None = None
        seen: set[int] = set()
        pages = 0
        while options.max_pages is None or pages < options.max_pages:
            body = {"query": QUERY, "variables": {"first": PAGE_SIZE, "after": after}}
            r = fetch.post(API, json_body=body)
            r.raise_for_status()
            data = r.json()
            if data.get("errors"):
                raise ValueError(f"bimhuis: {data['errors'][0].get('message')}")
            connection = data["data"]["events"]
            pages += 1
            for node in connection["nodes"]:
                if node["databaseId"] in seen:
                    continue
                seen.add(node["databaseId"])
                yield from self._events(node)
            if not connection["pageInfo"]["hasNextPage"]:
                break
            after = connection["pageInfo"]["endCursor"]

    def _events(self, node: dict[str, Any]) -> Iterator[Event]:
        tickets = node.get("ticketsData") or {}
        if tickets.get("externalLocation"):
            return
        times = node.get("times") or []
        for i, when in enumerate(times):
            location = clean(when.get("location"))
            if location not in OWN_ROOMS:
                continue
            start = _time(when.get("program_start"))
            if start is None:
                continue
            end = _time(when.get("program_end")) if when.get("program_end_visible") else None
            image = (node.get("featuredImage") or {}).get("node") or {}
            ticket_url = clean(when.get("ticket_link")) or clean(tickets.get("externalTicketUrl"))
            yield Event(
                venue=self.info.slug,
                source_id=str(node["databaseId"]) + (f"-{i}" if len(times) > 1 else ""),
                title=clean(node.get("title")) or "",
                start=start,
                doors=_time(when.get("door_open")),
                end=end if end and end > start else None,
                url=node.get("link"),
                room=location if location != "Bimhuis" else None,
                city=self.info.city,
                genres=_names(node, "filters") + _names(node, "specials"),
                categories=_names(node, "tags"),
                status=_EVENT_STATUS.get((when.get("status") or "").lower(), Status.SCHEDULED),
                availability=_availability(when, tickets),
                price=_price(when),
                ticket_url=ticket_url,
                description=strip_tags((node.get("eventData") or {}).get("excerpt")),
                image=image.get("sourceUrl"),
                extra={"ticket_id": when["event_id"]} if when.get("event_id") else {},
            )


def _time(value: str | None) -> datetime | None:
    """Times come as local "YYYYMMDDHHMM" strings."""
    if not value:
        return None
    return local(datetime.strptime(value, "%Y%m%d%H%M"))


def _names(node: dict[str, Any], taxonomy: str) -> list[str]:
    out: list[str] = []
    for term in (node.get(taxonomy) or {}).get("nodes") or []:
        name = clean(term.get("name"))
        if name and name not in out:
            out.append(name)
    return out


def _availability(when: dict[str, Any], tickets: dict[str, Any]) -> Availability:
    status = (when.get("status") or "").lower()
    if status == "sold-out":
        return Availability.SOLD_OUT
    if when.get("tickets_free"):
        return Availability.FREE
    if tickets.get("isLastTickets"):
        return Availability.FEW_LEFT
    return _SALE_STATUS.get(status, Availability.UNKNOWN)


def _price(when: dict[str, Any]) -> Price | None:
    """The regular prices (standing, seated), leaving out reductions like CJP."""
    if when.get("tickets_free"):
        return Price(0.0, 0.0, None)
    prices = when.get("price") or []
    regular = [p for p in prices if p.get("normal")] or prices
    amounts = []
    for p in regular:
        try:
            amounts.append(float(str(p.get("price")).replace(",", ".")))
        except ValueError:
            continue
    if not amounts:
        return None
    return Price(min(amounts), max(amounts), None)
