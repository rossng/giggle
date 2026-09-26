"""The event model every venue adapter produces."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any
from zoneinfo import ZoneInfo

AMSTERDAM = ZoneInfo("Europe/Amsterdam")


class Status(StrEnum):
    SCHEDULED = "scheduled"
    CANCELLED = "cancelled"
    POSTPONED = "postponed"
    MOVED = "moved"


class Availability(StrEnum):
    UNKNOWN = "unknown"
    ON_SALE = "on_sale"
    FEW_LEFT = "few_left"
    SOLD_OUT = "sold_out"
    FREE = "free"
    NOT_YET = "not_yet_on_sale"


@dataclass(frozen=True, slots=True)
class Price:
    """Ticket price in euros. `text` keeps the venue's own wording when it isn't a plain number."""

    min_eur: float | None = None
    max_eur: float | None = None
    text: str | None = None


@dataclass(frozen=True, slots=True)
class VenueInfo:
    slug: str
    name: str
    city: str
    website: str
    country: str = "NL"


@dataclass(slots=True)
class Event:
    """One dated event at a venue, as the venue lists it.

    Fields stay close to what the venue publishes. Adapters don't guess: if a venue
    doesn't say something, the field stays empty. `title` is the listing's own
    headline; `performers` and `support` are only filled when the venue states them.
    `source_id` is unique per venue and stable across runs for the same dated event.
    """

    venue: str
    source_id: str
    title: str
    start: datetime
    url: str | None = None
    subtitle: str | None = None
    doors: datetime | None = None
    end: datetime | None = None
    room: str | None = None
    city: str | None = None
    performers: list[str] = field(default_factory=list)
    support: list[str] = field(default_factory=list)
    genres: list[str] = field(default_factory=list)
    categories: list[str] = field(default_factory=list)
    status: Status = Status.SCHEDULED
    availability: Availability = Availability.UNKNOWN
    price: Price | None = None
    ticket_url: str | None = None
    description: str | None = None
    image: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for name in ("start", "doors", "end"):
            value = getattr(self, name)
            if value is not None and value.tzinfo is None:
                raise ValueError(f"{self.venue}/{self.source_id}: {name} must be timezone-aware")

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        for name in ("start", "doors", "end"):
            if data[name] is not None:
                data[name] = data[name].isoformat()
        data["status"] = str(self.status)
        data["availability"] = str(self.availability)
        return data
