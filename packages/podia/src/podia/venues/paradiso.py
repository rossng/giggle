"""Paradiso, Amsterdam. Reads the GraphQL API that paradiso.nl's own front end uses.

The API wants a bearer key that ships in the site's public JavaScript. It is not stored
here: each run reads the homepage, fetches its Next.js chunks one at a time and pulls
the key (and the endpoint) out of the first chunk that has them.

The programme covers every stage Paradiso books, including other venues (Tolhuistuin,
Bitterzoet, Parallel, Zonnehuis…). Only events in Paradiso's own building are yielded.
The API has no prices (`ticketPrice` is always empty) and fills unset clock times with
the time of the request, so only door times that sit just before the start are kept.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from datetime import datetime, timedelta
from typing import Any

from podia.extract import clean, combine, parse_iso, strip_tags
from podia.http import Fetcher
from podia.model import Availability, Event, Status, VenueInfo
from podia.venue import FetchOptions, Venue, register

SITE = "https://www.paradiso.nl"
PAGE_SIZE = 100
PLACEHOLDER = "REDACTED-TOKEN"

# Where the site's JS keeps the endpoint and the key:
#   "".concat("https://….execute-api.….amazonaws.com","/graphql"), "Bearer ".concat("…")
_CHUNK = re.compile(r'/_next/static/chunks/[^"\\\s]+\.js')
_TOKEN = re.compile(r'"Bearer "\.concat\("([^"]+)"\)')
_ENDPOINT = re.compile(
    r'"(https://[a-z0-9]+\.execute-api\.[a-z0-9.-]+\.amazonaws\.com)","/graphql"'
)
# Framework chunks that never hold app config; the rest are tried from the page's end.
_FRAMEWORK = re.compile(r"/(webpack|polyfills|main-app|framework)-[0-9a-f]+\.js$")

QUERY = """
query program($since: String, $size: Int, $after: [String]) {
  program(site: "paradisoNederlands", size: $size, gteStartDateTime: $since, searchAfter: $after) {
    events {
      id url title subtitle startDateTime doorsOpen supportAct soldOut eventStatus
      ticketUrl text importantInfo extras sort
      location { title }
      areas { label }
      subBrand { title }
      contentCategory { title }
      relatedArtists { title }
      image { type desktop }
    }
  }
}
"""

# Locations (from `location` or the "Location - Room" area labels) that are Paradiso itself.
OWN_LOCATIONS = {"Paradiso"}

# `contentCategory` mixes event types, genres and series tags in one list.
TYPES = {
    "Concert",
    "Club",
    "Dans",
    "Literair / Wetenschap / Politiek / Kunst",
    "Poëzie / Spoken Word",
}
TAGS = {
    "Stadspas",
    "LGBTQ+",
    "Amsterdam Dance Event",
    "SWANA in Paradiso",
    "Vriend van Paradiso",
    "Science & Cocktails",
    "Doe maar wat",
    "DIP",
}

STATUS = {
    "canceled": Status.CANCELLED,
    "postponed": Status.POSTPONED,
    "changeOfVenue": Status.MOVED,
}


@register
class Paradiso(Venue):
    info = VenueInfo(slug="paradiso", name="Paradiso", city="Amsterdam", website=SITE)

    def __init__(self) -> None:
        self._api: tuple[str, str] | None = None

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        endpoint, token = self._credentials(fetch)
        headers = {"Authorization": f"Bearer {token}"}
        after: list[str] | None = None
        page = 0
        while options.max_pages is None or page < options.max_pages:
            variables = {"since": options.since.isoformat(), "size": PAGE_SIZE, "after": after}
            r = fetch.post(
                endpoint, json_body={"query": QUERY, "variables": variables}, headers=headers
            )
            r.raise_for_status()
            data = r.json().get("data") or {}
            items = (data.get("program") or {}).get("events") or []
            for item in items:
                if _is_own(item):
                    yield self._event(item)
            page += 1
            if len(items) < PAGE_SIZE:
                break
            after = items[-1]["sort"]

    def _credentials(self, fetch: Fetcher) -> tuple[str, str]:
        """The API endpoint and bearer key, read from the site's JS once per instance."""
        if self._api is None:
            r = fetch.get(f"{SITE}/")
            r.raise_for_status()
            chunks = [c for c in dict.fromkeys(_CHUNK.findall(r.text)) if not _FRAMEWORK.search(c)]
            for chunk in reversed(chunks):
                js = fetch.get(SITE + chunk).text
                token, endpoint = _TOKEN.search(js), _ENDPOINT.search(js)
                if token and endpoint:
                    self._api = (endpoint[1] + "/graphql", token[1])
                    break
            else:
                raise LookupError("paradiso: no API key found in the site's scripts")
        return self._api

    def redact(self, url: str, text: str) -> str:
        if self._api is not None:
            text = text.replace(self._api[1], PLACEHOLDER)
        if url.rstrip("/") == SITE:
            # Only the script list is needed to find the chunks again.
            chunks = dict.fromkeys(_CHUNK.findall(text))
            return "".join(f'<script src="{c}"></script>\n' for c in chunks)
        if "/_next/static/chunks/" in url:
            endpoint = _ENDPOINT.search(text)
            if not (endpoint and _TOKEN.search(text)):
                return ""
            return f'"".concat("{endpoint[1]}","/graphql"),"Bearer ".concat("{PLACEHOLDER}")\n'
        if url.endswith("/graphql"):
            # Other venues' events only need what the filter and the pagination read.
            data = json.loads(text)
            events = ((data.get("data") or {}).get("program") or {}).get("events") or []
            for i, item in enumerate(events):
                if not _is_own(item):
                    events[i] = {k: item[k] for k in ("id", "location", "areas", "sort")}
            return json.dumps(data, ensure_ascii=False)
        return text

    def _event(self, item: dict[str, Any]) -> Event:
        start = parse_iso(item["startDateTime"])
        categories = [c["title"] for c in item["contentCategory"] if c["title"] in TYPES]
        genres = [c["title"] for c in item["contentCategory"] if c["title"] not in TYPES | TAGS]
        tags = [c["title"] for c in item["contentCategory"] if c["title"] in TAGS]
        extra: dict[str, Any] = {}
        if series := [s["title"] for s in item["subBrand"]]:
            extra["series"] = series
        if tags:
            extra["tags"] = tags
        if item["extras"]:
            extra["notes"] = item["extras"]  # e.g. access18YearsAndOverOnly, programSeatedOnly
        if artists := [a["title"] for a in item["relatedArtists"] or []]:
            extra["artists"] = artists
        if notice := strip_tags(item["importantInfo"]):
            extra["notice"] = notice
        return Event(
            venue=self.info.slug,
            source_id=item["id"],
            title=clean(item["title"]) or "",
            subtitle=clean(item["subtitle"]),
            start=start,
            doors=_doors(start, item["doorsOpen"]),
            url=item["url"],
            room=_room(item),
            city=self.info.city,
            support=[s for s in (clean(p) for p in (item["supportAct"] or "").split(",")) if s],
            genres=genres,
            categories=categories,
            status=STATUS.get(item["eventStatus"], Status.SCHEDULED),
            availability=_availability(item["soldOut"]),
            ticket_url=item["ticketUrl"] or None,
            description=strip_tags(item["text"]),
            image=_image(item["image"]),
            extra=extra,
        )


def _is_own(item: dict[str, Any]) -> bool:
    if item["location"]:
        return any(loc["title"] in OWN_LOCATIONS for loc in item["location"])
    # A few events have only areas ("Paradiso - Grote Zaal") and no location.
    return any(a["label"].split(" - ")[0] in OWN_LOCATIONS for a in item["areas"])


def _room(item: dict[str, Any]) -> str | None:
    rooms = []
    for area in item["areas"]:
        place, _, room = area["label"].partition(" - ")
        if place in OWN_LOCATIONS and room and room not in rooms:
            rooms.append(room)
    return ", ".join(rooms) or None


def _doors(start: datetime, clock: str | None) -> datetime | None:
    """Door time on the start's day. Unset times come back as the request time, so a
    door time more than three hours before the start is not trusted."""
    if not clock:
        return None
    doors = combine(start.date(), clock)
    if doors > start:
        doors -= timedelta(days=1)
    return doors if start - doors <= timedelta(hours=3) else None


def _availability(sold_out: str | None) -> Availability:
    # "yes", "yesWithWaitingList" or "no"
    if sold_out and sold_out.startswith("yes"):
        return Availability.SOLD_OUT
    return Availability.UNKNOWN


def _image(images: list[dict[str, Any]] | None) -> str | None:
    by_type = {i["type"]: i["desktop"] for i in images or [] if i.get("desktop")}
    return by_type.get("narrowCasting") or by_type.get("mediumSquare") or by_type.get("default")
