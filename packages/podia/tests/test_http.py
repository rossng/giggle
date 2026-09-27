"""The live client's limits, against a fake server (no network)."""

import gzip
import time
import tracemalloc
import zlib

import httpx
import pytest

import podia.http
from podia.http import Client, RobotsDisallowed, UnsafeResponse

PUBLIC = {"venue.test": ["93.184.215.14"]}


def client(handler, hosts=PUBLIC, **kw) -> Client:
    c = Client(min_delay=0, retries=0, resolver=lambda host: hosts.get(host, []), **kw)
    c._http = httpx.Client(transport=httpx.MockTransport(handler))
    return c


def site(routes):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(404)
        return routes(request)

    return handler


def test_follows_http_redirects_and_keeps_the_final_url():
    def routes(request):
        if request.url.path == "/old":
            return httpx.Response(301, headers={"Location": "https://venue.test/new"})
        return httpx.Response(200, text="agenda", headers={"content-type": "text/html"})

    r = client(site(routes)).get("http://venue.test/old")
    assert (r.url, r.status, r.text, r.content_type) == (
        "https://venue.test/new",
        200,
        "agenda",
        "text/html",
    )


@pytest.mark.parametrize("location", ["javascript:alert(1)", "file:///etc/passwd", "ftp://x/y"])
def test_refuses_redirects_away_from_http(location):
    def routes(request):
        return httpx.Response(302, headers={"Location": location})

    with pytest.raises(UnsafeResponse, match="redirects to"):
        client(site(routes)).get("https://venue.test/agenda")


def test_caps_the_body_size():
    big = b"x" * 1001

    def declared(request):
        return httpx.Response(200, content=big)

    with pytest.raises(UnsafeResponse, match="limit"):
        client(site(declared), max_bytes=1000).get("https://venue.test/")

    def streamed(request):  # no Content-Length: counted while reading
        return httpx.Response(200, content=iter([big[:600], big[600:]]))

    with pytest.raises(UnsafeResponse, match="limit"):
        client(site(streamed), max_bytes=1000).get("https://venue.test/")
    assert client(site(declared), max_bytes=2000).get("https://venue.test/").text == "x" * 1001


def test_redirect_loops_stop():
    def routes(request):
        return httpx.Response(302, headers={"Location": "/again"})

    with pytest.raises(httpx.TooManyRedirects):
        client(site(routes)).get("https://venue.test/")


def gzipped(data: bytes, layers: int = 1) -> bytes:
    for _ in range(layers):
        data = gzip.compress(data)
    return data


def test_decodes_gzip_and_deflate():
    def routes(request):
        if request.url.path == "/gz":
            body, coding = gzipped(b"agenda"), "gzip"
        elif request.url.path == "/zlib":
            body, coding = zlib.compress(b"agenda"), "deflate"
        else:  # raw deflate, as some servers send it
            c = zlib.compressobj(wbits=-zlib.MAX_WBITS)
            body, coding = c.compress(b"agenda") + c.flush(), "deflate"
        return httpx.Response(200, content=body, headers={"Content-Encoding": coding})

    c = client(site(routes))
    texts = [c.get(f"https://venue.test/{path}").text for path in ("gz", "zlib", "raw")]
    assert texts == ["agenda"] * 3


def test_decodes_concatenated_gzip_members():
    def routes(request):
        body = gzipped(b"agen") + gzipped(b"da")
        return httpx.Response(200, content=body, headers={"Content-Encoding": "gzip"})

    assert client(site(routes)).get("https://venue.test/").text == "agenda"


@pytest.mark.parametrize("layers", [1, 2])
def test_caps_the_decoded_body_of_a_gzip_bomb(layers):
    bomb = gzipped(b"\0" * 50_000_000, layers)  # 50 KB or so on the wire
    coding = ", ".join(["gzip"] * layers)

    def routes(request):  # streamed: a preloaded mock body would be decoded by httpx itself
        chunks = [bomb[i : i + 65536] for i in range(0, len(bomb), 65536)]
        return httpx.Response(200, content=iter(chunks), headers={"Content-Encoding": coding})

    tracemalloc.start()
    try:
        with pytest.raises(UnsafeResponse, match="limit|encoding"):
            client(site(routes), max_bytes=1_000_000).get("https://venue.test/")
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert peak < 10_000_000


@pytest.mark.parametrize("coding", ["gzip, gzip", "br", "zstd", "compress", "gzip, br"])
def test_refuses_stacked_or_unknown_encodings(coding):
    def routes(request):
        body = gzipped(b"x" * 10, 2)
        return httpx.Response(200, content=body, headers={"Content-Encoding": coding})

    with pytest.raises(UnsafeResponse, match="encoding"):
        client(site(routes)).get("https://venue.test/")


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "10.0.0.5",
        "169.254.169.254",
        "192.168.1.1",
        "::1",
        "fd00::1",
        "::ffff:10.0.0.1",
    ],
)
def test_refuses_private_hosts(address):
    def routes(request):
        return httpx.Response(200, text="secret")

    hosts = {"venue.test": ["93.184.215.14"], "evil.test": [address]}
    with pytest.raises(UnsafeResponse, match="private network"):
        client(site(routes), hosts).get("https://evil.test/")

    def redirecting(request):
        if request.url.host == "venue.test":
            return httpx.Response(302, headers={"Location": "http://evil.test/meta"})
        return httpx.Response(200, text="secret")

    with pytest.raises(UnsafeResponse, match="private network"):
        client(site(redirecting), hosts).get("https://venue.test/agenda")
    assert (
        client(site(routes), hosts, allow_private=True).get("https://evil.test/").text == "secret"
    )


def test_refuses_a_long_crawl_delay():
    def handler(request):
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text="User-agent: *\nCrawl-delay: 3600\n")
        return httpx.Response(200, text="agenda")

    with pytest.raises(RobotsDisallowed, match="3600"):
        client(handler).get("https://venue.test/")


def test_a_trickling_body_runs_out_of_time(monkeypatch):
    ticks = iter(range(0, 100_000, 50))  # a byte every 50 s: never a read timeout

    def routes(request):
        return httpx.Response(200, content=iter([b"x"] * 100))

    c = client(site(routes), request_seconds=180)
    monkeypatch.setattr(podia.http.time, "monotonic", lambda: next(ticks))
    with pytest.raises(UnsafeResponse, match="took over"):
        c.get("https://venue.test/")


def test_no_requests_after_the_deadline():
    def routes(request):
        return httpx.Response(200, text="agenda")

    c = client(site(routes), deadline=time.monotonic() - 1)
    with pytest.raises(UnsafeResponse, match="out of time"):
        c.get("https://venue.test/")
