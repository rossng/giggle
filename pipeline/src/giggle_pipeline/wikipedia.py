"""A short plain-text summary of an artist from Wikipedia.

MusicBrainz links most artists to Wikidata, whose sitelinks name the matching article
in each language; older entries link a Wikipedia article directly. English is
preferred, then Dutch (many local acts only have a Dutch article). The summary comes
from the REST API's page summary: the article's lead, already plain text.
Disambiguation pages are skipped: they describe a name, not the artist.

Wikimedia asks for an identifying User-Agent and modest request rates.
"""

from __future__ import annotations

import re
import time
from typing import Any
from urllib.parse import quote, unquote, urlparse

import httpx

from giggle_pipeline.cache import Cache, key_for
from giggle_pipeline.musicbrainz import USER_AGENT

WIKIDATA_API = "https://www.wikidata.org/w/api.php"
SUMMARY_API = "https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}"
LANGS = ("en", "nl")  # in order of preference
MAX_AGE = 90 * 86400

_QID = re.compile(r"/(Q\d+)$")
_ARTICLE = re.compile(r"^([a-z]+)\.(?:m\.)?wikipedia\.org$")


class WikipediaUnavailable(Exception):
    pass


def _article(url: str) -> tuple[str, str] | None:
    """(lang, title) from an article URL such as https://en.wikipedia.org/wiki/AC/DC."""
    parts = urlparse(url)
    host = _ARTICLE.match(parts.netloc)
    if not host or not parts.path.startswith("/wiki/"):
        return None
    return host.group(1), unquote(parts.path.removeprefix("/wiki/")).replace("_", " ")


class Wikipedia:
    interval = 0.2  # seconds between requests

    def __init__(self, cache: Cache, http: httpx.Client | None = None, max_requests: int = 1000):
        self.cache = cache
        self.http = http or httpx.Client(timeout=30)
        self.max_requests = max_requests
        self.requests = 0
        self._last = 0.0

    @property
    def exhausted(self) -> bool:
        return self.requests >= self.max_requests

    def _get(self, url: str, params: dict[str, str] | None = None) -> dict[str, Any] | None:
        """JSON from `url`, or None for a 404. Raises WikipediaUnavailable otherwise."""
        if self.exhausted:
            raise WikipediaUnavailable("request budget spent")
        wait = self.interval - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()
        self.requests += 1
        try:
            r = self.http.get(
                url, params=params, headers={"User-Agent": USER_AGENT}, follow_redirects=True
            )
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise WikipediaUnavailable(str(exc)) from exc

    def _sitelinks(self, qid: str) -> dict[str, str]:
        """{lang: article title} for the languages we want."""
        data = self._get(
            WIKIDATA_API,
            {
                "action": "wbgetentities",
                "ids": qid,
                "props": "sitelinks",
                "sitefilter": "|".join(f"{lang}wiki" for lang in LANGS),
                "format": "json",
            },
        )
        if data is None:
            return {}
        if "error" in data and data["error"].get("code") != "no-such-entity":
            raise WikipediaUnavailable(f"wikidata: {data['error'].get('info')}")
        titles = {}
        for entity in (data.get("entities") or {}).values():  # one, keyed by its current ID
            for site, link in (entity.get("sitelinks") or {}).items():
                titles[site.removesuffix("wiki")] = link["title"]
        return titles

    def summary(self, links: dict[str, str]) -> dict[str, Any] | None:
        """{title, lang, description, extract, url, thumbnail} for the artist behind
        MusicBrainz's `links`, or None. "No article" is cached; failures are not."""
        wikidata, wikipedia = links.get("wikidata"), links.get("wikipedia")
        qid = _QID.search(wikidata or "")
        if not qid and not wikipedia:
            return None
        key = key_for("summary", qid and qid.group(1), wikipedia)
        cached = self.cache.get("wikipedia", key, max_age=MAX_AGE)
        if cached is not None:
            return cached["summary"]
        try:
            titles = self._sitelinks(qid.group(1)) if qid else {}
            direct = _article(wikipedia) if wikipedia else None
            if direct and direct[0] in LANGS:
                titles.setdefault(*direct)
            result = None
            for lang in LANGS:
                if lang in titles:
                    result = self._page(lang, titles[lang])
                    if result:
                        break
        except WikipediaUnavailable:
            return None  # not cached: tried again next run
        self.cache.put("wikipedia", key, {"summary": result})
        return result

    def _page(self, lang: str, title: str) -> dict[str, Any] | None:
        path = quote(title.replace(" ", "_"), safe="")  # "AC/DC" → AC%2FDC
        page = self._get(SUMMARY_API.format(lang=lang, title=path))
        if not page or page.get("type") != "standard" or not page.get("extract"):
            return None  # missing, a disambiguation page, or empty
        thumbnail = (page.get("thumbnail") or {}).get("source")
        return {
            "title": page.get("title"),
            "lang": lang,
            "description": page.get("description"),
            "extract": page["extract"],
            "url": ((page.get("content_urls") or {}).get("desktop") or {}).get("page"),
            # drop the utm_ tracking query Wikimedia now appends to image URLs
            "thumbnail": thumbnail.split("?utm_")[0] if thumbnail else None,
        }
