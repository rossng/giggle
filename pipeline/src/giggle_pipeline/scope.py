"""Decide which events giggle keeps. The rules themselves live in scope.toml."""

from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass
from importlib.resources import files

from podia import Event

LIST_KEYS = (
    "status",
    "venue",
    "category",
    "category_word",
    "genre",
    "genre_prefix",
    "unless_category",
    "unless_genre",
)


@dataclass(frozen=True, slots=True)
class Rule:
    reason: str
    status: frozenset[str] = frozenset()
    venue: frozenset[str] = frozenset()
    category: frozenset[str] = frozenset()
    category_word: re.Pattern[str] | None = None
    genre: frozenset[str] = frozenset()
    genre_prefix: tuple[str, ...] = ()
    no_genres: bool = False
    unless_category: frozenset[str] = frozenset()
    unless_genre: frozenset[str] = frozenset()

    @classmethod
    def from_toml(cls, raw: dict) -> Rule:
        unknown = set(raw) - {"reason", "no_genres", *LIST_KEYS}
        if unknown:
            raise ValueError(f"unknown keys in scope rule {raw.get('reason')!r}: {unknown}")
        values = {k: [v.lower() for v in raw.get(k, [])] for k in LIST_KEYS}
        words = values.pop("category_word")
        return cls(
            reason=raw["reason"],
            no_genres=raw.get("no_genres", False),
            genre_prefix=tuple(values.pop("genre_prefix")),
            category_word=_whole_words(words) if words else None,
            **{k: frozenset(v) for k, v in values.items()},
        )

    def matches(self, event: Event) -> bool:
        categories = {c.lower() for c in event.categories}
        genres = {g.lower() for g in event.genres}
        if categories & self.unless_category or genres & self.unless_genre:
            return False
        checks = []
        if self.status:
            checks.append(str(event.status) in self.status)
        if self.venue:
            checks.append(event.venue in self.venue)
        if self.category:
            checks.append(bool(categories & self.category))
        if self.category_word:
            checks.append(any(self.category_word.search(c) for c in categories))
        if self.genre or self.genre_prefix:
            checks.append(
                bool(genres & self.genre)
                or any(g.startswith(p) for g in genres for p in self.genre_prefix)
            )
        if self.no_genres:
            checks.append(not genres)
        return bool(checks) and all(checks)


def _whole_words(words: list[str]) -> re.Pattern[str]:
    """Any of `words` (or phrases) as whole words: "comedy" in "Comedy!", not in "Comedyclub"."""
    alternatives = "|".join(re.escape(w) for w in sorted(words, key=len, reverse=True))
    return re.compile(rf"(?<!\w)(?:{alternatives})(?!\w)")


def load_rules(text: str | None = None) -> list[Rule]:
    if text is None:
        text = files("giggle_pipeline").joinpath("scope.toml").read_text()
    return [Rule.from_toml(r) for r in tomllib.loads(text)["rule"]]


def exclusion_reason(event: Event, rules: list[Rule]) -> str | None:
    """The reason the first matching rule gives, or None to keep the event."""
    for rule in rules:
        if rule.matches(event):
            return rule.reason
    return None
