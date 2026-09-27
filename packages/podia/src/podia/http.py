"""A polite HTTP client, plus a replay client for tests.

Adapters only talk to the network through `Fetcher`, so tests can swap in recorded
responses and the live client can enforce robots.txt and crawl delays in one place.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import socket
import time
import zlib
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit

import httpx
from protego import Protego

DEFAULT_USER_AGENT = "podia/0.1 (+https://pypi.org/project/podia/)"
MIN_DELAY_SECONDS = 1.0
MAX_CRAWL_DELAY_SECONDS = 30.0  # a site asking for more is treated as refusing us
MAX_BODY_BYTES = 20_000_000  # the biggest agenda (Patronaat's XML) is ~1 MB
REQUEST_SECONDS = 180.0  # one request, redirects and body included
MAX_REDIRECTS = 10
WEB_SCHEMES = ("http", "https")
# The content codings podia decodes itself, one at most, so the body cap holds for the
# decoded bytes. "deflate" is zlib-wrapped by the spec; some servers send it raw.
CODINGS = {"gzip": 16 + zlib.MAX_WBITS, "x-gzip": 16 + zlib.MAX_WBITS, "deflate": zlib.MAX_WBITS}


class RobotsDisallowed(Exception):
    pass


class UnsafeResponse(httpx.HTTPError):
    """A response podia won't read: too big, too slow, oddly encoded, redirecting away
    from http(s), or from a host on a private network."""


def resolve(host: str) -> list[str]:
    """The addresses `host` resolves to (none if it doesn't resolve)."""
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except (OSError, UnicodeError):
        return []
    return [str(info[4][0]) for info in infos]


def is_public(address: str) -> bool:
    """Whether `address` is on the public internet (not private, loopback, link-local…)."""
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


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
    """Live client: follows http(s) redirects, keeps cookies, honours robots.txt and
    crawl-delay, and reads at most `max_bytes` of a (decoded) response body.

    It only talks to public hosts: a URL or redirect whose host resolves to a private,
    loopback or link-local address is refused (`allow_private=True` turns that off, e.g.
    for a venue mirror on the LAN). The check resolves the name apart from the
    connection, so it stops mistakes and hostile links, not DNS rebinding.

    Time is bounded too: a site whose robots.txt asks for more than `max_crawl_delay`
    between requests is treated as disallowing podia; one request (redirects and body
    included) gets `request_seconds`, so a server trickling bytes can't hold it open;
    and `deadline`, a `time.monotonic()` value, ends all the client's requests.
    """

    def __init__(
        self,
        user_agent: str = DEFAULT_USER_AGENT,
        timeout: float = 60.0,  # Patronaat serves ~1 MB of XML slowly
        retries: int = 2,
        min_delay: float = MIN_DELAY_SECONDS,
        max_bytes: int = MAX_BODY_BYTES,
        *,
        max_crawl_delay: float = MAX_CRAWL_DELAY_SECONDS,
        request_seconds: float = REQUEST_SECONDS,
        deadline: float | None = None,
        allow_private: bool = False,
        resolver: Callable[[str], list[str]] = resolve,
    ) -> None:
        self.user_agent = user_agent
        self.retries = retries
        self.min_delay = min_delay
        self.max_bytes = max_bytes
        self.max_crawl_delay = max_crawl_delay
        self.request_seconds = request_seconds
        self.deadline = deadline
        self.allow_private = allow_private
        self.resolver = resolver
        # Redirects are followed by `_send`, which checks where each one goes. Bodies are
        # decoded by `_read`, so only the codings it handles are offered.
        self._http = httpx.Client(
            headers={"User-Agent": user_agent, "Accept-Encoding": "gzip, deflate"},
            timeout=timeout,
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
                r = self._send(self._http.build_request("GET", f"{origin}/robots.txt"))
                self._robots[origin] = Protego.parse(r.text) if r.status == 200 else None
            except httpx.HTTPError:
                self._robots[origin] = None
        return self._robots[origin]

    def _crawl_delay(self, url: str, robots: Protego | None) -> float:
        """The pause to keep between requests to `url`'s host. A site asking for more
        than `max_crawl_delay` would stall a crawl for hours, so podia stays away."""
        asked = float(robots.crawl_delay(self.user_agent) or 0) if robots is not None else 0.0
        if asked > self.max_crawl_delay:
            raise RobotsDisallowed(
                f"{url}: robots.txt asks for {asked:g} s between requests "
                f"(podia waits at most {self.max_crawl_delay:g} s)"
            )
        return max(self.min_delay, asked)

    def _wait_turn(self, url: str, delay: float) -> None:
        host = urlsplit(url).netloc
        last = self._last_request.get(host)
        if last is not None:
            remaining = delay - (time.monotonic() - last)
            if remaining > 0:
                self._sleep(remaining, url)
        self._last_request[host] = time.monotonic()

    def _sleep(self, seconds: float, url: str) -> None:
        if self.deadline is not None and time.monotonic() + seconds > self.deadline:
            raise UnsafeResponse(f"{url}: out of time (the client's deadline has passed)")
        time.sleep(seconds)

    def _request(
        self, method, url, *, params=None, headers=None, json_body=None, data=None
    ) -> Response:
        if self.deadline is not None and time.monotonic() > self.deadline:
            raise UnsafeResponse(f"{url}: out of time (the client's deadline has passed)")
        robots = self._robots_for(url)
        full_url = str(httpx.URL(url, params=params)) if params else url
        if robots is not None and not robots.can_fetch(full_url, self.user_agent):
            raise RobotsDisallowed(full_url)
        delay = self._crawl_delay(url, robots)
        for attempt in range(self.retries + 1):
            self._wait_turn(url, delay)
            request = self._http.build_request(
                method, url, params=params, headers=headers, json=json_body, data=data
            )
            try:
                r = self._send(request)
            except httpx.TransportError:
                if attempt == self.retries:
                    raise
                self._sleep(2**attempt, url)
                continue
            if r.status >= 500 and attempt < self.retries:
                self._sleep(2**attempt, url)
                continue
            return r
        raise AssertionError("unreachable")

    def _check_host(self, url: httpx.URL) -> None:
        if self.allow_private:
            return
        # A name that doesn't resolve can't be connected to either; httpx reports that.
        if any(not is_public(address) for address in self.resolver(url.host)):
            raise UnsafeResponse(f"{url}: {url.host} is on a private network")

    def _send(self, request: httpx.Request) -> Response:
        """Send `request`, following redirects to http(s) URLs on public hosts only, and
        read at most `max_bytes` of the final body within `request_seconds`."""
        ends = time.monotonic() + self.request_seconds
        if self.deadline is not None:
            ends = min(ends, self.deadline)
        for _ in range(MAX_REDIRECTS + 1):
            self._check_host(request.url)
            try:
                r = self._http.send(request, stream=True)
            except httpx.InvalidURL as exc:  # the Location header, e.g. "javascript:…"
                raise UnsafeResponse(f"{request.url} redirects to an invalid URL: {exc}") from None
            try:
                if r.next_request is None:
                    return Response(
                        str(r.url),
                        r.status_code,
                        self._read(r, ends).decode(r.encoding or "utf-8", errors="replace"),
                        r.headers.get("content-type", ""),
                    )
                request = r.next_request
            finally:
                r.close()
            if request.url.scheme not in WEB_SCHEMES:
                raise UnsafeResponse(f"{r.url} redirects to a {request.url.scheme}: URL")
            if time.monotonic() > ends:
                raise UnsafeResponse(f"{r.url}: out of time following redirects")
        raise httpx.TooManyRedirects(f"more than {MAX_REDIRECTS} redirects", request=request)

    def _read(self, r: httpx.Response, ends: float) -> bytes:
        """The decoded body. More than `max_bytes` of it (counted after decompression, so
        a small gzip bomb can't get past) or still reading at `ends` is refused."""
        declared = r.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > self.max_bytes:
            raise UnsafeResponse(f"{r.url}: {declared} bytes, over the {self.max_bytes} limit")
        codings = [
            coding
            for part in r.headers.get("content-encoding", "").split(",")
            if (coding := part.strip().lower()) not in ("", "identity")
        ]
        if len(codings) > 1 or (codings and codings[0] not in CODINGS):
            raise UnsafeResponse(f"{r.url}: content encoding {', '.join(codings)} not supported")
        body = bytearray()
        # The undecoded bytes (`iter_raw` would refuse a body a mock transport preloaded).
        raw = iter(r.stream)  # type: ignore[call-overload]
        for piece in _decoded(raw, codings[0] if codings else None, self.max_bytes):
            body += piece
            if len(body) > self.max_bytes:
                raise UnsafeResponse(f"{r.url}: body over the {self.max_bytes} byte limit")
            if time.monotonic() > ends:
                raise UnsafeResponse(f"{r.url}: took over {self.request_seconds:g} s")
        return bytes(body)


def _decoded(raw: Iterator[bytes], coding: str | None, limit: int) -> Iterator[bytes]:
    """`raw` chunks decoded from one content coding, at most `limit` + 1 bytes at a time,
    so a caller counting the output stops a decompression bomb early."""
    if coding is None:
        yield from raw
        return
    wbits = CODINGS[coding]
    d = zlib.decompressobj(wbits)
    first = True
    try:
        for chunk in raw:
            if not chunk:
                continue
            if first and coding == "deflate" and not _zlib_header(chunk):
                wbits = -zlib.MAX_WBITS  # raw deflate, no zlib wrapper
                d = zlib.decompressobj(wbits)
            first = False
            data = chunk
            while data:
                yield d.decompress(data, limit + 1)
                data = d.unconsumed_tail
                if d.eof and d.unused_data:  # gzip allows several members back to back
                    data = d.unused_data + data
                    d = zlib.decompressobj(wbits)
        yield d.flush()
    except zlib.error as exc:
        raise httpx.DecodingError(f"invalid {coding} body: {exc}") from None


def _zlib_header(chunk: bytes) -> bool:
    return len(chunk) >= 2 and chunk[0] & 0x0F == 8 and (chunk[0] << 8 | chunk[1]) % 31 == 0


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
