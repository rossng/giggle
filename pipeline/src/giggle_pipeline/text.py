"""Text folding shared by every step that compares names and titles."""

from __future__ import annotations

import re
import unicodedata


def fold(text: str) -> str:
    """Lower case ASCII: accents dropped ("Mélanie" → "melanie"), other non-ASCII gone."""
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()


def plain(text: str) -> str:
    """`fold`, with punctuation turned into single spaces: "AC/DC!" → "ac dc"."""
    return " ".join("".join(c if c.isalnum() else " " for c in fold(text)).split())


def normalise(name: str) -> str:
    """An artist's name as a lookup key: folded, no leading "the", letters and digits only."""
    return re.sub(r"[^a-z0-9]+", "", re.sub(r"^the\s+", "", fold(name)))
