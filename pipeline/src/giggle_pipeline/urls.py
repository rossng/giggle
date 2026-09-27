"""Only web links reach the site.

Venue pages, MusicBrainz (which anyone can edit), Last.fm and Wikipedia all supply URLs
that the web app puts in links and images. A `javascript:` or `data:` URL there would
run on giggle's origin, so every URL field in the published JSON must be http(s); any
other is dropped.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

URL_KEYS = {"url", "image", "thumbnail", "website", "homepage"}  # plus "*_url" and links


def is_web_url(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parts = urlsplit(value.strip())
    except ValueError:
        return False
    return parts.scheme.lower() in ("http", "https") and bool(parts.netloc)


def _is_url_key(key: str) -> bool:
    return key in URL_KEYS or key.endswith(("_url", "Url"))


def web_urls_only(value: Any, links: bool = False) -> Any:
    """`value` (site JSON) with every URL field that isn't http(s) set to None. Values
    under a "links" object are all URLs; a bad one is left out."""
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if (links or _is_url_key(key)) and isinstance(item, str) and not is_web_url(item):
                if links:
                    continue
                item = None
            out[key] = web_urls_only(item, links=key == "links")
        return out
    if isinstance(value, list):
        return [web_urls_only(item) for item in value]
    return value
