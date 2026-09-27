import pytest

from giggle_pipeline.urls import is_web_url, web_urls_only


@pytest.mark.parametrize(
    "url",
    ["https://www.paradiso.nl/x", "http://occii.org/events/a/", "HTTPS://Example.com"],
)
def test_web_urls_pass(url):
    assert is_web_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "java\tscript:alert(1)",
        " javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox",
        "/relative/image.jpg",
        "//evil.example/x",
        "https://",
        "http://[::1",  # not parseable
        None,
        42,
    ],
)
def test_everything_else_fails(url):
    assert not is_web_url(url)


def test_url_fields_anywhere_in_the_site_json_are_checked():
    site = {
        "gigs": [
            {
                "url": "https://venue.nl/a",
                "ticket_url": "javascript:steal()",
                "image": "data:image/svg+xml,<svg onload=alert(1)>",
                "description": "javascript: the musical",  # not a URL field
                "price": None,
            }
        ],
        "artists": {
            "mb:1": {
                "musicbrainz": {
                    "links": {"homepage": "javascript:x()", "bandcamp": "https://x.bandcamp.com"}
                },
                "lastfm": {"url": "https://www.last.fm/music/X", "bio": "javascript:"},
                "wikipedia": {"url": "vbscript:x", "thumbnail": "https://upload.wikimedia.org/a"},
                "youtube": {"image": "https://lh3.googleusercontent.com/a", "songs": []},
            }
        },
    }
    clean = web_urls_only(site)
    gig = clean["gigs"][0]
    assert (gig["url"], gig["ticket_url"], gig["image"]) == ("https://venue.nl/a", None, None)
    assert gig["description"] == "javascript: the musical"
    artist = clean["artists"]["mb:1"]
    assert artist["musicbrainz"]["links"] == {"bandcamp": "https://x.bandcamp.com"}
    assert artist["lastfm"] == {"url": "https://www.last.fm/music/X", "bio": "javascript:"}
    assert artist["wikipedia"]["url"] is None
    assert artist["wikipedia"]["thumbnail"] == "https://upload.wikimedia.org/a"
    assert artist["youtube"]["image"].startswith("https://")
