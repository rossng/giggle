"""Find an artist on YouTube Music and their top songs, with a local cache.

Uses ytmusicapi without an account: an artist search, then the artist page for top
songs, monthly listeners, description and photo. Only an exact name match counts, so
a small band doesn't get a famous namesake's songs.

Answers are cached with the time they were fetched: "not found" is asked again after
`NOT_FOUND_MAX_AGE`, a found artist after `FOUND_MAX_AGE` (their top songs move). The API
is unofficial and can change under us, so a night that finds nobody at all, or keeps
failing, stops looking and caches none of its "not found" answers: otherwise one bad
night would mark every artist it saw as not on YouTube Music for weeks.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ytmusicapi import YTMusic

from giggle_pipeline.text import normalise

CACHE_VERSION = 2
FOUND_MAX_AGE = 90 * 86400
NOT_FOUND_MAX_AGE = 14 * 86400
JUDGE_AFTER = 20  # answers before "nobody found" means the lookup is broken
MAX_CONSECUTIVE_ERRORS = 10
MAX_ERRORS = 10  # this many failed lookups in a run need looking at


class ArtistLookup:
    def __init__(
        self,
        cache_file: Path,
        delay: float = 0.5,
        max_lookups: int | None = None,
        now: Callable[[], float] = time.time,
    ) -> None:
        self.cache_file = cache_file
        self.delay = delay
        self.max_lookups = max_lookups  # None: unlimited; 0: cached answers only
        self.now = now
        self._yt: YTMusic | None = None
        self.cache: dict[str, dict[str, Any]] = {}  # key: {"value": …, "fetched": time}
        if cache_file.exists():
            data = json.loads(cache_file.read_text())
            if data.get("version") == CACHE_VERSION:
                self.cache = data["artists"]
            elif data.get("version") == 1:
                self.cache = {k: _migrated(k, v, now()) for k, v in data["artists"].items()}
        self.lookups = self.found = self.not_found = self.errors = 0
        self._consecutive_errors = 0
        self.gave_up: str | None = None  # why lookups stopped for this run
        self._negatives: dict[str, dict[str, Any] | None] = {}  # new "not found": old entry

    def save(self) -> None:
        if self.gave_up:  # tonight's "not found" answers can't be trusted
            for key, previous in self._negatives.items():
                if previous is None:
                    self.cache.pop(key, None)
                else:
                    self.cache[key] = previous
            self._negatives.clear()
        self.cache_file.parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": CACHE_VERSION, "artists": self.cache}
        self.cache_file.write_text(json.dumps(payload, ensure_ascii=False, indent=1))

    def problem(self) -> str | None:
        """Why this run's lookups need a person to look, if they do."""
        if self.gave_up:
            return f"Stopped looking up artists: {self.gave_up}."
        if self.errors >= MAX_ERRORS:
            return f"{self.errors} of {self.lookups} lookups failed."
        return None

    def find(self, name: str) -> dict[str, Any] | None:
        key = normalise(name)
        if not key:
            return None
        entry = self.cache.get(key)
        if entry is not None and self._fresh(entry):
            return entry["value"]
        stale = entry["value"] if entry is not None else None
        if self.gave_up or (self.max_lookups is not None and self.lookups >= self.max_lookups):
            return stale  # looked up on a later run
        self.lookups += 1
        try:
            value = self._lookup(name, key)
        except Exception as exc:  # unofficial API: a failure skips this artist
            print(f"ytmusic: {name}: {exc!r}", file=sys.stderr)
            self.errors += 1
            self._consecutive_errors += 1
            if self._consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                self.gave_up = f"{self._consecutive_errors} lookups in a row failed ({exc!r})"
            return stale
        finally:
            time.sleep(self.delay)
        self._consecutive_errors = 0
        if value is None:
            self.not_found += 1
            self._negatives.setdefault(key, entry)
        else:
            self.found += 1
        self.cache[key] = {"value": value, "fetched": self.now()}
        if not self.found and self.not_found >= JUDGE_AFTER:
            self.gave_up = f"none of {self.not_found} artists found, so the API may have changed"
        return value

    def _fresh(self, entry: dict[str, Any]) -> bool:
        max_age = FOUND_MAX_AGE if entry["value"] is not None else NOT_FOUND_MAX_AGE
        return self.now() - entry["fetched"] <= max_age

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


def _migrated(key: str, value: dict[str, Any] | None, now: float) -> dict[str, Any]:
    """A version-1 entry (no fetch time), dated somewhere within its max age so the old
    answers come up for renewal a few each night rather than all at once."""
    max_age = FOUND_MAX_AGE if value is not None else NOT_FOUND_MAX_AGE
    spread = int.from_bytes(hashlib.sha256(key.encode()).digest()[:4]) / 2**32
    return {"value": value, "fetched": now - spread * max_age}
