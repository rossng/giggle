"""Match artist names to MusicBrainz, and fetch the basics about each artist.

MusicBrainz is the identity everything else joins on: its artist ID links to
Wikidata, Wikipedia, Bandcamp and YouTube, and gives formation year, origin and
genres. Many names are shared ("Nouvelle Vague" is a French bossa nova band, a
Japanese group and a 1980s band), so candidates with the exact name are ranked by how
well their tags fit the gig's genres, then by MusicBrainz's own relevance score.

The API allows one request per second and asks for an identifying User-Agent. It
answers 503 when rate limited or overloaded: we back off and retry a few times, and if it
still fails, stop asking for the rest of the run rather than stall the nightly build.
"""

from __future__ import annotations

import re
import time
import unicodedata
from collections.abc import Callable
from typing import Any

import httpx

from giggle_pipeline.cache import Cache, key_for

API = "https://musicbrainz.org/ws/2"
USER_AGENT = "giggle/0.1 (https://github.com/rossng/giggle)"
DETAILS_MAX_AGE = 90 * 86400
INTERVAL = 1.1  # seconds between requests
BACKOFF = (5, 10, 20)  # seconds to wait before each retry
COOL_DOWN = (60, 120)  # after a lookup fails all its retries: pause, then carry on
MAX_OUTAGES = 3  # failed lookups before giving up on MusicBrainz for the run
# Under load, MusicBrainz sheds search requests (503 with "x-ratelimit-who: search-shed"
# and "retry-after: 0"): that's the service being busy, not us being limited, and a retry
# a moment later usually works. These get short jittered waits and don't count as outages.
SHED_WAITS = (1.5, 2.0, 2.5, 3.0, 3.5, 3.5)
LINK_TYPES = {
    "bandcamp": "bandcamp",
    "wikidata": "wikidata",
    "wikipedia": "wikipedia",
    "youtube": "youtube",
    "official homepage": "homepage",
    "soundcloud": "soundcloud",
    "free streaming": "streaming",
}


def normalise(name: str) -> str:
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    text = re.sub(r"^the\s+", "", text)
    return re.sub(r"[^a-z0-9]+", "", text)


def _words(values: list[str]) -> set[str]:
    return {w for v in values for w in re.findall(r"[a-z]+", v.lower()) if len(w) > 2}


def _voted(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Tags or genres by votes, most first, without the ones voted down to zero or below."""
    return sorted((i for i in items if i.get("count", 0) > 0), key=lambda i: -i["count"])


def phrase(value: str) -> str:
    """`value` as a Lucene phrase: quoted, with backslashes and quotes escaped."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


class MusicBrainzUnavailable(Exception):
    pass


# Failures that leave nothing to cache: the lookup is tried again next run.
FAILURES = (MusicBrainzUnavailable, httpx.HTTPError, ValueError)  # ValueError: bad JSON


class MusicBrainz:
    def __init__(
        self,
        cache: Cache,
        max_requests: int = 600,
        *,
        http: httpx.Client | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.cache = cache
        self.http = http or httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=30)
        self.sleep = sleep
        self.max_requests = max_requests
        self.requests = 0  # HTTP requests made, retries included
        self.outages = 0  # lookups that failed all their retries
        self.sheds = 0  # search requests MusicBrainz shed under load (retried quickly)
        self.unavailable = False  # too many outages: no more requests this run
        self._last = 0.0

    @property
    def exhausted(self) -> bool:
        return self.requests >= self.max_requests

    def _get(self, path: str, params: dict[str, str]) -> dict[str, Any]:
        backoffs = list(BACKOFF)
        sheds = list(SHED_WAITS)
        wait_next = 0.0
        while True:
            if self.exhausted and wait_next:
                raise MusicBrainzUnavailable(f"{path}: out of requests while retrying")
            wait = max(wait_next, INTERVAL - (time.monotonic() - self._last))
            if wait > 0:
                self.sleep(wait)
            self._last = time.monotonic()
            self.requests += 1
            try:
                r = self.http.get(f"{API}/{path}", params={**params, "fmt": "json"})
            except httpx.TransportError:
                r = None  # timeout or connection error: back off and retry
            if r is not None and r.status_code < 500:
                r.raise_for_status()
                return r.json()
            if r is not None and r.headers.get("x-ratelimit-who", "").endswith("shed") and sheds:
                wait_next = sheds.pop(0)
                self.sheds += 1
                continue
            if not backoffs:
                break
            wait_next = backoffs.pop(0)
        # A short network blip shouldn't cost the whole night, but a real outage shouldn't
        # cost minutes of backoff per remaining artist either: pause and carry on, and
        # give up only once it keeps happening.
        self.outages += 1
        if self.outages >= MAX_OUTAGES:
            self.unavailable = True
        else:
            self.sleep(COOL_DOWN[self.outages - 1])
        raise MusicBrainzUnavailable(f"{path}: still failing after {len(BACKOFF)} retries")

    def match(self, name: str, genres: list[str]) -> dict[str, Any] | None:
        """The best MusicBrainz candidate for `name`, or None. Answers (including
        "no match") are cached; returns None without caching when out of budget or
        MusicBrainz is unavailable."""
        key = key_for("mb-match", normalise(name), sorted(_words(genres)))
        cached = self.cache.get("musicbrainz", key)
        if cached is not None:
            return cached.get("match")
        if self.exhausted or self.unavailable or not normalise(name):
            return None
        try:
            # Without a leading "The": the phrase still finds "The X", and "X" is found too.
            query = re.sub(r"^the\s+(?=\S)", "", name.strip(), flags=re.IGNORECASE)
            data = self._get("artist", {"query": f"artist:{phrase(query)}", "limit": "8"})
        except FAILURES:
            return None  # not cached: tried again next run
        wanted = _words(genres)
        exact = [a for a in data.get("artists", []) if normalise(a["name"]) == normalise(name)]
        best = None
        if exact:

            def rank(a: dict[str, Any]) -> tuple[int, int, int]:
                tags = _words([t["name"] for t in _voted(a.get("tags", []))])
                return (len(tags & wanted), int(a.get("score", 0)), len(tags))

            exact.sort(key=rank, reverse=True)
            top = exact[0]
            overlap = rank(top)[0]
            if len(exact) == 1 or overlap > rank(exact[1])[0]:
                confidence = "high"
            elif rank(top)[1] - rank(exact[1])[1] >= 10:
                confidence = "medium"  # clearly the best-known of the namesakes
            else:
                confidence = "low"
            best = {
                "mbid": top["id"],
                "name": top["name"],
                "disambiguation": top.get("disambiguation"),
                "namesakes": len(exact) - 1,
                "confidence": confidence,
            }
        self.cache.put("musicbrainz", key, {"match": best})
        return best

    def match_by_id(self, mbid: str, source: str) -> dict[str, Any] | None:
        """A match from an MBID another source supplied (Last.fm): looked up by ID, which
        doesn't go through MusicBrainz's search service. "medium" confidence, since the
        other source doesn't know the gig's genres to tell namesakes apart."""
        details = self.details(mbid)
        if details is None or not details.get("name"):
            return None
        return {
            "mbid": mbid,
            "name": details["name"],
            "disambiguation": None,
            "namesakes": None,
            "confidence": "medium",
            "source": source,
        }

    def details(self, mbid: str) -> dict[str, Any] | None:
        cached = self.cache.get("musicbrainz", f"details:{mbid}", max_age=DETAILS_MAX_AGE)
        if cached is not None:
            return cached
        if self.exhausted or self.unavailable:
            return None
        try:
            a = self._get(f"artist/{mbid}", {"inc": "url-rels+genres+tags"})
        except FAILURES:
            return None
        links: dict[str, str] = {}
        for rel in a.get("relations", []):
            kind = LINK_TYPES.get(rel.get("type", ""))
            url = (rel.get("url") or {}).get("resource")
            if kind and url and kind not in links:
                links[kind] = url
        span = a.get("life-span") or {}
        info = {
            "mbid": mbid,
            "name": a.get("name"),
            "type": a.get("type"),  # Group, Person, Orchestra…
            "country": a.get("country"),
            "area": (a.get("area") or {}).get("name"),
            "begin_area": (a.get("begin-area") or {}).get("name"),
            "begin": span.get("begin"),
            "ended": span.get("ended"),
            "genres": [g["name"] for g in _voted(a.get("genres", []))][:8],
            "tags": [t["name"] for t in _voted(a.get("tags", []))][:8],
            "links": links,
        }
        self.cache.put("musicbrainz", f"details:{mbid}", info)
        return info
