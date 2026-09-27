"""Helpers shared by adapters: structured data in pages, Dutch dates, prices, text cleanup."""

from __future__ import annotations

import html
import json
import re
from collections.abc import Iterator
from datetime import date, datetime, time
from typing import Any
from urllib.parse import urljoin, urlsplit

from selectolax.parser import HTMLParser, Node

from podia.model import AMSTERDAM, Price

DUTCH_MONTHS = {
    "jan": 1, "januari": 1, "feb": 2, "februari": 2, "mrt": 3, "maart": 3, "mar": 3,
    "apr": 4, "april": 4, "mei": 5, "may": 5, "jun": 6, "juni": 6, "jul": 7, "juli": 7,
    "aug": 8, "augustus": 8, "sep": 9, "sept": 9, "september": 9, "okt": 10, "oct": 10,
    "oktober": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
    "january": 1, "february": 2, "march": 3, "june": 6, "july": 7, "august": 8,
}  # fmt: skip

_WS = re.compile(r"\s+")
_PRICE = re.compile(r"(\d+(?:[.,]\d{1,2})?)")


def clean(text: str | None) -> str | None:
    """Collapse whitespace and unescape entities. Empty results become None."""
    if text is None:
        return None
    text = _WS.sub(" ", html.unescape(text)).strip()
    return text or None


def node_text(node: Node | None, separator: str = " ") -> str | None:
    """A parsed node's text, cleaned (see `clean`); None for a missing node."""
    return clean(node.text(separator=separator)) if node is not None else None


def strip_tags(fragment: str | None) -> str | None:
    if not fragment:
        return None
    return clean(HTMLParser(fragment).text(separator=" "))


def site_url(base: str, href: str | None) -> str | None:
    """`href` (usually a path) resolved against the site `base`, or None when it's empty
    or leads to another host: pages are fetched from these URLs, and `base + href` with
    an href like "@evil.example/x" would put the site's name in the userinfo instead."""
    if not href or not href.strip():
        return None
    url = urljoin(base.rstrip("/") + "/", href.strip())
    parts, site = urlsplit(url), urlsplit(base)
    if parts.scheme not in ("http", "https") or parts.netloc.lower() != site.netloc.lower():
        return None
    return url


def local(dt: datetime) -> datetime:
    """Treat a naive datetime as Amsterdam time; convert an aware one to Amsterdam time."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=AMSTERDAM)
    return dt.astimezone(AMSTERDAM)


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    return local(datetime.fromisoformat(value.replace("Z", "+00:00")))


def combine(day: date, clock: str | None) -> datetime:
    """Join a date with a "20:30" / "20.30" time; midnight if the time is missing."""
    if clock:
        m = re.search(r"(\d{1,2})[:.](\d{2})", clock)
        if m:
            return datetime.combine(day, time(int(m[1]), int(m[2])), AMSTERDAM)
    return datetime.combine(day, time(0, 0), AMSTERDAM)


def infer_year(month: int, day: int, since: date, grace_days: int = 7) -> date | None:
    """Date for a listing that shows only day and month ("za. 26 sept."): the first year
    that puts it no more than `grace_days` before `since`. Agendas rarely run past a year."""
    for year in (since.year, since.year + 1):
        try:
            candidate = date(year, month, day)
        except ValueError:  # 29 February in a non-leap year
            continue
        if (candidate - since).days >= -grace_days:
            return candidate
    return None


def month_number(name: str) -> int:
    return DUTCH_MONTHS[name.strip(". ").lower()]


def parse_price(text: str | None) -> Price | None:
    """Read "€ 24,50", "vanaf €17", "gratis" and similar into a Price."""
    text = clean(text)
    if not text:
        return None
    lowered = text.lower()
    if "gratis" in lowered or "free" in lowered:
        return Price(0.0, 0.0, text)
    amounts = [float(a.replace(",", ".")) for a in _PRICE.findall(text.replace("€", " "))]
    if not amounts:
        return Price(text=text)
    return Price(min(amounts), max(amounts), text)


def json_ld(page: str) -> Iterator[dict[str, Any]]:
    """Every schema.org object in a page's JSON-LD blocks, with @graph flattened."""
    for node in HTMLParser(page).css('script[type="application/ld+json"]'):
        try:
            data = json.loads(node.text(strip=True))
        except json.JSONDecodeError:
            continue
        stack = data if isinstance(data, list) else [data]
        while stack:
            item = stack.pop(0)
            if not isinstance(item, dict):
                continue
            if "@graph" in item:
                stack.extend(item["@graph"])
            else:
                yield item


_EMAIL = re.compile(r"[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}", re.I)


def mask_emails(text: str) -> str:
    """Replace email addresses (organisers' contact details in event texts) before a
    response is saved as a fixture."""
    return _EMAIL.sub("email@example.invalid", text)


def next_data(page: str) -> dict[str, Any] | None:
    """The `__NEXT_DATA__` payload of a Next.js pages-router site."""
    node = HTMLParser(page).css_first("script#__NEXT_DATA__")
    return json.loads(node.text()) if node is not None else None


_FLIGHT_PUSH = re.compile(r'self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)')
_FLIGHT_TEXT = re.compile(rb"T([0-9a-f]+),")


def next_flight(page: str) -> list[Any]:
    """The JSON rows of a Next.js app-router page's React Server Components payload
    (the `self.__next_f.push([1, "…"])` scripts), parsed. Other rows (module imports,
    hints) are skipped.

    The payload is a series of `<id>:<row>` records: most run to the end of the line,
    but a text row (`T<hex length>,`) is that many bytes and has no line break after it.
    Long strings are sent as text rows and referenced as "$<id>"; those references are
    replaced by the text, and "$$…" (an escaped "$") is unescaped.
    """
    payload = "".join(json.loads(s) for s in _FLIGHT_PUSH.findall(page)).encode()
    rows: list[Any] = []
    texts: dict[str, str] = {}
    i = 0
    while i < len(payload):
        colon = payload.find(b":", i)
        if colon < 0:
            break
        row_id = payload[i:colon].decode(errors="replace").strip()
        text = _FLIGHT_TEXT.match(payload, colon + 1)
        if text:
            i = text.end() + int(text[1], 16)
            texts[row_id] = payload[text.end() : i].decode(errors="replace")
            continue
        end = payload.find(b"\n", colon)
        end = len(payload) if end < 0 else end
        row = payload[colon + 1 : end]
        i = end + 1
        if row[:1] in (b"[", b"{"):
            try:
                rows.append(json.loads(row))
            except json.JSONDecodeError:
                continue

    def resolve(value: Any) -> Any:
        if isinstance(value, str) and value.startswith("$"):
            if value.startswith("$$"):
                return value[1:]
            return texts.get(value[1:], value)
        if isinstance(value, list):
            return [resolve(v) for v in value]
        if isinstance(value, dict):
            return {k: resolve(v) for k, v in value.items()}
        return value

    return [resolve(row) for row in rows]
