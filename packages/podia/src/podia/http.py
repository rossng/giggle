"""A polite HTTP client, plus a replay client for tests.

Adapters only talk to the network through `Fetcher`, so tests can swap in recorded
responses and the live client can enforce robots.txt and crawl delays in one place.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit

import httpx
from protego import Protego

DEFAULT_USER_AGENT = "podia/0.1 (+https://pypi.org/project/podia/)"
MIN_DELAY_SECONDS = 1.0


class RobotsDisallowed(Exception):
    pass


@dataclass(frozen=True, slots=True)
class Response:
    url: str
    status: int
    text: str
    content_type: str = ""

    def json(self) -> Any:
        return json.loads(self.text)

    def raise_for_status(self) -> None:
        if self.status >= 400:
            raise httpx.HTTPStatusError(
                f"{self.status} for {self.url}",
                request=httpx.Request("GET", self.url),
                response=httpx.Response(self.status),
            )


class Fetcher(Protocol):
    def get(
        self,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> Response: ...

    def post(
        self,
        url: str,
        *,
        json_body: Any = None,
        data: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
    ) -> Response:
        """POST a JSON body (`json_body`) or a form-encoded one (`data`)."""
        ...


def post_body(json_body: Any, data: dict[str, str] | None) -> Any:
    """What identifies a POST body in a recording. JSON bodies stay as-is so older
    recordings keep matching; form bodies are tagged so the two can't collide."""
    return json_body if data is None else {"form": data}


def request_key(method: str, url: str, params: dict[str, Any] | None, body: Any) -> str:
    """Stable identity of a request, used to match recordings."""
    payload = json.dumps([method, url, params or {}, body], sort_keys=True, default=str)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


class Client:
    """Live client: follows redirects, keeps cookies, honours robots.txt and crawl-delay."""

    def __init__(
        self,
        user_agent: str = DEFAULT_USER_AGENT,
        timeout: float = 60.0,  # Patronaat serves ~1 MB of XML slowly
        retries: int = 2,
        min_delay: float = MIN_DELAY_SECONDS,
    ) -> None:
        self.user_agent = user_agent
        self.retries = retries
        self.min_delay = min_delay
        self._http = httpx.Client(
            headers={"User-Agent": user_agent},
            timeout=timeout,
            follow_redirects=True,
        )
        self._robots: dict[str, Protego | None] = {}
        self._last_request: dict[str, float] = {}

    def __enter__(self) -> Client:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._http.close()

    def get(self, url, *, params=None, headers=None) -> Response:
        return self._request("GET", url, params=params, headers=headers)

    def post(self, url, *, json_body=None, data=None, headers=None) -> Response:
        return self._request("POST", url, json_body=json_body, data=data, headers=headers)

    def _robots_for(self, url: str) -> Protego | None:
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in self._robots:
            try:
                r = self._http.get(f"{origin}/robots.txt")
                self._robots[origin] = Protego.parse(r.text) if r.status_code == 200 else None
            except httpx.HTTPError:
                self._robots[origin] = None
        return self._robots[origin]

    def _wait_turn(self, url: str, robots: Protego | None) -> None:
        host = urlsplit(url).netloc
        delay = self.min_delay
        if robots is not None:
            delay = max(delay, robots.crawl_delay(self.user_agent) or 0)
        last = self._last_request.get(host)
        if last is not None:
            remaining = delay - (time.monotonic() - last)
            if remaining > 0:
                time.sleep(remaining)
        self._last_request[host] = time.monotonic()

    def _request(
        self, method, url, *, params=None, headers=None, json_body=None, data=None
    ) -> Response:
        robots = self._robots_for(url)
        full_url = str(httpx.URL(url, params=params)) if params else url
        if robots is not None and not robots.can_fetch(full_url, self.user_agent):
            raise RobotsDisallowed(full_url)
        for attempt in range(self.retries + 1):
            self._wait_turn(url, robots)
            try:
                r = self._http.request(
                    method, url, params=params, headers=headers, json=json_body, data=data
                )
            except httpx.TransportError:
                if attempt == self.retries:
                    raise
                time.sleep(2**attempt)
                continue
            if r.status_code >= 500 and attempt < self.retries:
                time.sleep(2**attempt)
                continue
            return Response(str(r.url), r.status_code, r.text, r.headers.get("content-type", ""))
        raise AssertionError("unreachable")


class Recorder:
    """Wraps a live client and saves every response, for building test fixtures.

    `redact` lets an adapter strip sensitive or bulky parts of a response before it is
    written to disk. Fixtures end up in the repo, so they must be safe to publish.
    """

    def __init__(self, inner: Fetcher, directory: Path, redact=None) -> None:
        self.inner = inner
        self.directory = directory
        self.redact = redact or (lambda url, text: text)
        self.index: dict[str, dict[str, Any]] = {}
        directory.mkdir(parents=True, exist_ok=True)

    def get(self, url, *, params=None, headers=None) -> Response:
        r = self.inner.get(url, params=params, headers=headers)
        return self._save("GET", url, params, None, r)

    def post(self, url, *, json_body=None, data=None, headers=None) -> Response:
        r = self.inner.post(url, json_body=json_body, data=data, headers=headers)
        return self._save("POST", url, None, post_body(json_body, data), r)

    def _save(self, method, url, params, body, r: Response) -> Response:
        key = request_key(method, url, params, body)
        text = self.redact(url, r.text)
        suffix = ".json" if "json" in r.content_type else ".txt"
        (self.directory / f"{key}{suffix}").write_text(text)
        self.index[key] = {
            "method": method,
            "url": url,
            "params": params,
            "body": body,
            "status": r.status,
            "content_type": r.content_type,
            "file": f"{key}{suffix}",
        }
        (self.directory / "index.json").write_text(json.dumps(self.index, indent=2, sort_keys=True))
        return Response(r.url, r.status, text, r.content_type)


class Replay:
    """Serves recorded responses. An unrecorded request is an error, never a network call."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.index = json.loads((directory / "index.json").read_text())

    def get(self, url, *, params=None, headers=None) -> Response:
        return self._load("GET", url, params, None)

    def post(self, url, *, json_body=None, data=None, headers=None) -> Response:
        return self._load("POST", url, None, post_body(json_body, data))

    def _load(self, method, url, params, body) -> Response:
        key = request_key(method, url, params, body)
        entry = self.index.get(key)
        if entry is None:
            raise LookupError(f"no recording for {method} {url} params={params} body={body}")
        text = (self.directory / entry["file"]).read_text()
        return Response(url, entry["status"], text, entry["content_type"])
