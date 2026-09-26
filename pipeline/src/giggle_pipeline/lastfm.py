"""Popularity, tags, similar artists and a short bio from Last.fm.

Listener counts tell a headliner from a bedroom project, and Last.fm's tags and
similar artists are denser than MusicBrainz's for small acts. Lookups go by MusicBrainz
ID when we have one; Last.fm doesn't know every MBID, so a miss falls back to the name
with autocorrect. Without an API key (LASTFM_API_KEY) every method returns None and the
build carries on without Last.fm.

The key is sent with each request only: it never appears in cache keys or cached values.
Last.fm asks for no more than a few requests per second.
"""

from __future__ import annotations

import html
import re
import time
from typing import Any

import httpx

from giggle_pipeline.cache import Cache, key_for
from giggle_pipeline.musicbrainz import USER_AGENT, normalise

API = "https://ws.audioscrobbler.com/2.0/"
INFO_MAX_AGE = 7 * 86400  # listener counts move
TOP_TRACKS_MAX_AGE = 30 * 86400
NOT_FOUND_MAX_AGE = 14 * 86400  # long enough not to re-ask nightly, short enough to notice new acts
NOT_FOUND = 6  # "Invalid parameters", which is also how getInfo says "artist not found"

_READ_MORE = re.compile(r"<a\b[^>]*>\s*Read more on Last\.fm.*", re.S | re.I)
_TAG = re.compile(r"<[^>]+>")


class LastFMUnavailable(Exception):
    pass


class _NotFound(Exception):
    pass


def _as_list(value: Any) -> list[Any]:
    """Last.fm's JSON is converted from XML: a list can arrive as a single object,
    or as "" when empty."""
    if isinstance(value, list):
        return value
    return [value] if isinstance(value, dict) else []


def _int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def plain_bio(summary: str | None) -> str | None:
    """The bio summary without its "Read more on Last.fm" link or any other HTML."""
    text = _READ_MORE.sub("", summary or "")
    text = html.unescape(_TAG.sub("", text))
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


class LastFM:
    interval = 0.25  # seconds between requests

    def __init__(
        self,
        cache: Cache,
        api_key: str | None,
        http: httpx.Client | None = None,
        max_requests: int = 1500,
    ) -> None:
        self.cache = cache
        self.api_key = api_key
        self.http = http or httpx.Client(timeout=30)
        self.max_requests = max_requests
        self.requests = 0
        self._last = 0.0

    @property
    def exhausted(self) -> bool:
        return self.requests >= self.max_requests

    def _get(self, method: str, params: dict[str, str]) -> dict[str, Any]:
        """One API call. Raises _NotFound for an unknown artist, LastFMUnavailable for
        anything worth retrying next run (rate limits, outages, a bad key)."""
        wait = self.interval - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()
        self.requests += 1
        query = {**params, "method": method, "api_key": self.api_key or "", "format": "json"}
        try:
            r = self.http.get(API, params=query, headers={"User-Agent": USER_AGENT})
            data = r.json()
        except (httpx.HTTPError, ValueError):
            # the exception text would include the URL, and with it the key
            raise LastFMUnavailable(f"{method}: request failed") from None
        if not isinstance(data, dict):
            raise LastFMUnavailable(f"{method}: unexpected response")
        if "error" in data:
            if data["error"] == NOT_FOUND:
                raise _NotFound(data.get("message"))
            raise LastFMUnavailable(f"{method}: error {data['error']}: {data.get('message')}")
        if r.status_code != 200:
            raise LastFMUnavailable(f"{method}: HTTP {r.status_code}")
        return data

    def _lookup(self, method: str, name: str, mbid: str | None, extra: dict[str, str]) -> Any:
        """By MBID first, then by name. Returns None when neither is known."""
        attempts = [{"mbid": mbid}] if mbid else []
        attempts.append({"artist": name, "autocorrect": "1"})
        for params in attempts:
            if self.exhausted:
                raise LastFMUnavailable("request budget spent")
            try:
                return self._get(method, {**params, **extra})
            except _NotFound:
                continue
        return None

    def _cached(self, key: str, max_age: float) -> dict[str, Any] | None:
        """The cached entry if still fresh. "Not found" entries have their own TTL, so
        the age is checked against the time stored in the value."""
        hit = self.cache.get("lastfm", key, max_age=max(max_age, NOT_FOUND_MAX_AGE))
        if hit is None:
            return None
        ttl = NOT_FOUND_MAX_AGE if hit["value"] is None else max_age
        return hit if time.time() - hit["fetched"] <= ttl else None

    def _store(self, key: str, value: Any) -> None:
        self.cache.put("lastfm", key, {"value": value, "fetched": time.time()})

    def info(self, name: str, mbid: str | None) -> dict[str, Any] | None:
        """Listeners, plays, tags, similar artists and a plain-text bio, or None if
        Last.fm doesn't know the artist (cached) or can't be asked (not cached)."""
        if self.api_key is None:
            return None
        key = key_for("info", mbid, normalise(name))
        cached = self._cached(key, INFO_MAX_AGE)
        if cached is not None:
            return cached["value"]
        try:
            data = self._lookup("artist.getInfo", name, mbid, {})
        except LastFMUnavailable:
            return None
        info = None
        if data is not None:
            a = data.get("artist") or {}
            stats = a.get("stats") or {}
            tags = _as_list((a.get("tags") or {}).get("tag"))
            similar = _as_list((a.get("similar") or {}).get("artist"))
            info = {
                "name": a.get("name"),
                "mbid": a.get("mbid") or None,
                "url": a.get("url"),
                "listeners": _int(stats.get("listeners")),
                "playcount": _int(stats.get("playcount")),
                "tags": [t["name"] for t in tags][:8],
                "similar": [s["name"] for s in similar][:10],
                "bio": plain_bio((a.get("bio") or {}).get("summary")),
            }
        self._store(key, info)
        return info

    def top_tracks(self, name: str, mbid: str | None) -> list[dict[str, Any]] | None:
        """Up to ten most-played tracks, or None as for `info`."""
        if self.api_key is None:
            return None
        key = key_for("top-tracks", mbid, normalise(name))
        cached = self._cached(key, TOP_TRACKS_MAX_AGE)
        if cached is not None:
            return cached["value"]
        try:
            data = self._lookup("artist.getTopTracks", name, mbid, {"limit": "10"})
        except LastFMUnavailable:
            return None
        tracks = None
        if data is not None:
            tracks = [
                {
                    "title": t.get("name"),
                    "listeners": _int(t.get("listeners")),
                    "playcount": _int(t.get("playcount")),
                }
                for t in _as_list((data.get("toptracks") or {}).get("track"))
            ][:10]
        self._store(key, tracks)
        return tracks
