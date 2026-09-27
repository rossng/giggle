"""Artist names from a gig title, by simple rules: the line-up fallback when the LLM
can't answer (and the fake LLM's answers). Splits the title on the separators venues
commonly use ("A + B", "A w/ B", "A • Festival").
"""

from __future__ import annotations

import re

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
