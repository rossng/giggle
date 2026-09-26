"""Find an artist on YouTube Music and their top songs, with a local cache.

Uses ytmusicapi without an account: an artist search, then the artist page for top
songs, monthly listeners, description and photo. Only an exact name match counts, so
a small band doesn't get a famous namesake's songs. Every answer, including "not
found", is cached, so a nightly run only looks up artists it hasn't seen.
"""

from __future__ import annotations

import json
import re
import time
import unicodedata
from pathlib import Path
from typing import Any

from ytmusicapi import YTMusic

CACHE_VERSION = 1


def normalise(name: str) -> str:
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    text = re.sub(r"^the\s+", "", text)
    return re.sub(r"[^a-z0-9]+", "", text)


class ArtistLookup:
    def __init__(self, cache_file: Path, delay: float = 0.5) -> None:
        self.cache_file = cache_file
        self.delay = delay
        self._yt: YTMusic | None = None
        self.cache: dict[str, Any] = {}
        if cache_file.exists():
            data = json.loads(cache_file.read_text())
            if data.get("version") == CACHE_VERSION:
                self.cache = data["artists"]
        self.lookups = 0

    def save(self) -> None:
        self.cache_file.parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": CACHE_VERSION, "artists": self.cache}
        self.cache_file.write_text(json.dumps(payload, ensure_ascii=False, indent=1))

    def find(self, name: str) -> dict[str, Any] | None:
        key = normalise(name)
        if not key:
            return None
        if key not in self.cache:
            self.cache[key] = self._lookup(name, key)
            self.lookups += 1
            time.sleep(self.delay)
        return self.cache[key]

    def _lookup(self, name: str, key: str) -> dict[str, Any] | None:
        if self._yt is None:
            self._yt = YTMusic()
        results = self._yt.search(name, filter="artists", limit=5)
        match = next((r for r in results if normalise(r.get("artist", "")) == key), None)
        if match is None or not match.get("browseId"):
            return None
        page = self._yt.get_artist(match["browseId"])
        songs = [
            {
                "videoId": s["videoId"],
                "title": s["title"],
                "album": (s.get("album") or {}).get("name"),
            }
            for s in (page.get("songs") or {}).get("results", [])
            if s.get("videoId")
        ]
        thumbs = page.get("thumbnails") or []
        return {
            "name": page.get("name") or match["artist"],
            "browseId": match["browseId"],
            "monthlyListeners": page.get("monthlyListeners"),
            "description": page.get("description"),
            "image": thumbs[-1]["url"] if thumbs else None,
            "songs": songs[:5],
        }
