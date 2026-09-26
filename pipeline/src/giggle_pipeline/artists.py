"""Artist names from a gig listing, by simple rules.

This is a stopgap until the LLM step parses titles properly: it uses the venue's
structured performers and support acts when there are any, and otherwise splits the
title on the separators venues commonly use ("A + B", "A w/ B", "A • Festival").
"""

from __future__ import annotations

import re
from typing import Any

_PREFIX = re.compile(
    r"^(uitverkocht|sold out|verplaatst|nieuwe datum|extra show|afgelast|geannuleerd|"
    r"nieuw|new|last tickets|laatste kaarten)\s*[:!-]\s*",
    re.I,
)
_LABEL = re.compile(r"^[^:]{1,25}:\s+(?=\S)")  # "Discover: Ronker", "Kreukelzone: Bohem"
_BRACKETS = re.compile(r"\s*[(\[][^)\]]*[)\]]")
_TAIL = re.compile(r"\s+(•|\||–|—|-|:)\s+.*$")
_PHRASES = re.compile(
    r"\b(album|ep|single)\s*release(\s*show|\s*party)?\b|\breleaseshow\b|\bpresents?\b|"
    r"\b(\w+\s)?tour(\s\d{4})?\b|\blive\b|\bin concert\b",
    re.I,
)
_SPLIT = re.compile(r"\s+(?:\+|w/|with|ft\.?|feat\.?|featuring)\s+|\s*,\s*", re.I)
_NOISE = {"support", "supports", "guests", "guest", "tba", "e.a.", "and more", "special guest"}


def names_from_text(text: str) -> list[str]:
    text = _PREFIX.sub("", text.strip())
    label = _LABEL.match(text)
    if label and len(label[0].split()) <= 2:
        text = text[label.end() :]
    text = _BRACKETS.sub("", text)
    text = _TAIL.sub("", text)
    text = _PHRASES.sub("", text)
    names = []
    for part in _SPLIT.split(text):
        part = part.strip(" .:-'\"")
        if len(part) > 1 and part.lower() not in _NOISE:
            names.append(part)
    return names


def artists_for(gig: dict[str, Any], limit: int = 3) -> list[str]:
    """Names from the title first, then the venue's performers and support acts.

    The title leads because some venues' "performers" are a band's members."""
    names = names_from_text(gig["title"]) + list(gig.get("performers") or [])
    for support in gig.get("support") or []:
        names.extend(names_from_text(support))
    seen, unique = set(), []
    for name in names:
        if name.lower() not in seen:
            seen.add(name.lower())
            unique.append(name)
    return unique[:limit]
