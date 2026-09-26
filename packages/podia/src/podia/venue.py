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

    `events()` should stay cheap: ideally one or a few requests for the whole agenda. When
    some fields are only on per-event pages, an adapter sets `has_details = True` and
    overrides `details()`, so callers can fetch those pages only for the events they care
    about (typically the ones they haven't seen before).
    """

    info: ClassVar[VenueInfo]
    has_details: ClassVar[bool] = False

    @abstractmethod
    def events(self, fetch: Fetcher, options: FetchOptions | None = None) -> Iterator[Event]:
        """Yield upcoming events, soonest first where the source allows.
        `options` defaults to `FetchOptions()`."""

    def details(self, fetch: Fetcher, event: Event) -> Event:
        """Return `event` enriched from its own page (room, price, ticket link, times…).

        The contract, for every adapter:
        - pure enrichment: the result has the same `venue` and `source_id`, fills empty
          fields or corrects ones the listing got only approximately (e.g. a doors time
          given as the start), and never empties a field the listing filled;
        - the input event is not modified; a new `Event` is returned (or the same one when
          there is nothing to add);
        - it may raise on network or parse errors; the caller decides whether to keep the
          listing's event.

        The default returns the event unchanged; `has_details` says whether an adapter
        does more.
        """
        return event

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
