"""Helpers shared by adapters: structured data in pages, Dutch dates, prices, text cleanup."""

from __future__ import annotations

import html
import json
import re
from collections.abc import Iterator
from datetime import date, datetime, time
from typing import Any

from selectolax.parser import HTMLParser

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


def strip_tags(fragment: str | None) -> str | None:
    if not fragment:
        return None
    return clean(HTMLParser(fragment).text(separator=" "))


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


def next_data(page: str) -> dict[str, Any] | None:
    """The `__NEXT_DATA__` payload of a Next.js pages-router site."""
    node = HTMLParser(page).css_first("script#__NEXT_DATA__")
    return json.loads(node.text()) if node is not None else None
