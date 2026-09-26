"""Base class and registry for venue adapters."""

from __future__ import annotations

import importlib
import pkgutil
from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import date
from typing import ClassVar

from podia.http import Fetcher
from podia.model import Event, VenueInfo


@dataclass(frozen=True, slots=True)
class FetchOptions:
    """`since`: the first day of interest, for sources that take a date in the query.
    Adapters must use this rather than `date.today()`, so recorded fixtures replay.
    `max_pages` caps paginated sources; tests and fixture recording use a small value."""

    since: date = field(default_factory=date.today)
    max_pages: int | None = None


class Venue(ABC):
    """One venue's agenda.

    Subclasses set `info` and implement `events()`. They should prefer structured sources
    (APIs, feeds, embedded JSON) over HTML, never store raw pages, and put every network
    call through the given `Fetcher`.
    """

    info: ClassVar[VenueInfo]

    @abstractmethod
    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        """Yield upcoming events, soonest first where the source allows.
        `options` defaults to `FetchOptions()`."""

    def redact(self, url: str, text: str) -> str:
        """Trim a response before it is saved as a test fixture. Override to remove anything
        sensitive or bulky. The default keeps the response unchanged."""
        return text


_REGISTRY: dict[str, type[Venue]] = {}


def register(cls: type[Venue]) -> type[Venue]:
    slug = cls.info.slug
    if slug in _REGISTRY and _REGISTRY[slug] is not cls:
        raise ValueError(f"duplicate venue slug {slug!r}")
    _REGISTRY[slug] = cls
    return cls


def _load_all() -> None:
    import podia.venues

    for module in pkgutil.iter_modules(podia.venues.__path__):
        importlib.import_module(f"podia.venues.{module.name}")


def all_venues() -> dict[str, type[Venue]]:
    _load_all()
    return dict(sorted(_REGISTRY.items()))


def get_venue(slug: str) -> Venue:
    venues = all_venues()
    try:
        return venues[slug]()
    except KeyError:
        raise KeyError(f"unknown venue {slug!r}; known: {', '.join(venues)}") from None
