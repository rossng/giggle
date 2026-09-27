"""The live client's limits, against a fake server (no network)."""

import httpx
import pytest

from podia.http import Client, UnsafeResponse


def client(handler, **kw) -> Client:
    c = Client(min_delay=0, retries=0, **kw)
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
