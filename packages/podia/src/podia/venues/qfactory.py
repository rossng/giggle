"""Q-Factory, Amsterdam. Reads the event data embedded in the "Podium" page.

The site is a Next.js app on Storyblok. Its podium page (`/nl/podium`) carries every
published event as a Storyblok story in the page's React Server Components payload (one
request): title, start and door time, room ("location"), genres, a category (concert,
festival, lezing…), the ticket button with its price text, a description and an image.
Past events are in there too and are left out.

Door times are sometimes stale (a date months before the show); only a door time on
the start's day, at or before it, is kept.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import datetime, timedelta
from typing import Any

from podia.extract import clean, local, mask_emails, next_flight, parse_price
from podia.http import Fetcher
from podia.model import Availability, Event, Status, VenueInfo
from podia.venue import FetchOptions, Venue, register

BASE = "https://q-factory.com"
PODIUM = f"{BASE}/nl/podium"
EVENT_PREFIX = "nl/events/"


@register
class QFactory(Venue):
    info = VenueInfo(slug="qfactory", name="Q-Factory", city="Amsterdam", website=BASE)

    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        options = options or FetchOptions()
        r = fetch.get(PODIUM)
        r.raise_for_status()
        events = []
        for story in _stories(r.text).values():
            event = self._event(story)
            if event is not None and event.start.date() >= options.since:
                events.append(event)
        yield from sorted(events, key=lambda e: (e.start, e.source_id))

    def _event(self, story: dict[str, Any]) -> Event | None:
        content = story["content"]
        start = _datetime(content.get("startTime"))
        title = clean(content.get("title")) or clean(story.get("name"))
        if start is None or not title:
            return None
        doors = _datetime(content.get("openTime"))
        end = _datetime(content.get("endDate"))
        button = next(iter(content.get("primaryCta") or []), {})
        label = (clean(button.get("label")) or "").lower()
        price = parse_price(button.get("price"))
        if price is not None and price.min_eur is None:
            price = None  # "€" alone, or no amount at all
        ticket_url = ((button.get("link") or {}).get("url") or "").strip() or None
        image = (content.get("image") or {}).get("filename") or None
        extra: dict[str, Any] = {}
        for key in ("youtubeEmbedSrc", "spotifyEmbedSrc"):
            if url := (content.get(key) or "").strip():
                extra[key.removesuffix("EmbedSrc")] = url
        return Event(
            venue=self.info.slug,
            source_id=story["slug"],
            title=title,
            start=start,
            url=f"{BASE}/{story['full_slug']}",
            doors=doors if doors and doors.date() == start.date() and doors <= start else None,
            end=end if end and start < end < start + timedelta(days=4) else None,
            room=", ".join(_names(content.get("location"))) or None,
            city=self.info.city,
            genres=_names(content.get("genre")),
            categories=_names(content.get("categories")),
            status=Status.CANCELLED
            if "geannuleerd" in label or "cancel" in label
            else Status.SCHEDULED,
            availability=_availability(label, price, ticket_url),
            price=price,
            ticket_url=ticket_url if ticket_url and ticket_url.startswith("http") else None,
            description=_rich_text(content.get("description"))
            or _rich_text(content.get("preview")),
            image=image,
            extra=extra,
        )

    def redact(self, url: str, text: str) -> str:
        return mask_emails(self._trim(url, text))

    def _trim(self, url: str, text: str) -> str:
        """Only the event stories, trimmed to the fields read here, in the same kind of
        script the page uses."""
        stories = []
        for story in _stories(text).values():
            content = {k: v for k, v in story["content"].items() if k != "_uid"}
            for key in ("location", "genre", "categories"):
                content[key] = [{"name": n} for n in _names(content.get(key))]
            stories.append(
                {k: story[k] for k in ("uuid", "name", "slug", "full_slug")} | {"content": content}
            )
        row = "0:" + json.dumps(stories, ensure_ascii=False) + "\n"
        return f"<script>self.__next_f.push([1,{json.dumps(row, ensure_ascii=False)}])</script>\n"


def _stories(page: str) -> dict[str, dict[str, Any]]:
    """Every event story in the page, by uuid (the payload repeats some)."""
    found: dict[str, dict[str, Any]] = {}
    stack: list[Any] = list(next_flight(page))
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            slug = node.get("full_slug")
            if (
                isinstance(slug, str)
                and slug.startswith(EVENT_PREFIX)
                and isinstance(node.get("content"), dict)
            ):
                found.setdefault(node["uuid"], node)
                continue
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return found


def _datetime(value: str | None) -> datetime | None:
    """ "2026-10-16 20:30", local time."""
    try:
        return local(datetime.fromisoformat(value.strip())) if value else None
    except ValueError:
        return None


def _names(stories: Any) -> list[str]:
    """Names of linked stories (genres, categories, rooms)."""
    names = []
    for story in stories or []:
        if isinstance(story, dict) and (name := clean(story.get("name"))):
            names.append(name)
    return names


def _rich_text(doc: Any) -> str | None:
    """Plain text of a Storyblok rich-text document, paragraphs joined by spaces."""
    parts: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("type") == "text":
                parts.append(node.get("text") or "")
            elif node.get("type") == "hard_break":
                parts.append(" ")
            for child in node.get("content") or []:
                walk(child)
            if node.get("type") == "paragraph":
                parts.append(" ")

    walk(doc)
    return clean("".join(parts))


def _availability(label: str, price: Any, ticket_url: str | None) -> Availability:
    """From the ticket button: "Tickets", "Free Event", "Uitverkocht"…"""
    if "uitverkocht" in label or "sold out" in label:
        return Availability.SOLD_OUT
    if "free" in label or "gratis" in label or (price is not None and price.max_eur == 0):
        return Availability.FREE
    if "ticket" in label and ticket_url:
        return Availability.ON_SALE
    return Availability.UNKNOWN
