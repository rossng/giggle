import json
from pathlib import Path

import httpx

from giggle_pipeline.cache import Cache
from giggle_pipeline.wikipedia import Wikipedia

FIXTURES = Path(__file__).parent / "fixtures" / "wikipedia"
BLAUDZUN = {"wikidata": "https://www.wikidata.org/wiki/Q3043285"}  # en + nl articles
DE_KAST = {"wikidata": "https://www.wikidata.org/wiki/Q5240409"}  # nl article only


def fixture(name):
    return json.loads((FIXTURES / name).read_text())


def entity(qid, **titles):
    """A wbgetentities answer with the given {lang: title} sitelinks."""
    links = {f"{lang}wiki": {"site": f"{lang}wiki", "title": t} for lang, t in titles.items()}
    return {"entities": {qid: {"type": "item", "id": qid, "sitelinks": links}}, "success": 1}


PAGES = {
    "www.wikidata.org/Q3043285": fixture("wikidata_Q3043285.json"),
    "www.wikidata.org/Q5240409": fixture("wikidata_Q5240409.json"),
    "www.wikidata.org/Q1": entity("Q1", en="Mercury", nl="De Kast"),
    "www.wikidata.org/Q2": entity("Q2", en="Mercury"),
    "en.wikipedia.org/Blaudzun": fixture("summary_en_Blaudzun.json"),
    "nl.wikipedia.org/De_Kast": fixture("summary_nl_De_Kast.json"),
    "en.wikipedia.org/Mercury": fixture("summary_en_Mercury.json"),
}


def client(tmp_path, pages=PAGES, status=None):
    """A Wikipedia served from `pages` (404 for anything else), logging each request."""
    seen = []

    def handler(request):
        url = request.url
        if url.host == "www.wikidata.org":
            key = f"{url.host}/{url.params['ids']}"
        else:
            key = f"{url.host}/{url.path.rsplit('/', 1)[-1]}"
        seen.append(key)
        assert request.headers["User-Agent"].startswith("giggle/")
        if status:
            return httpx.Response(status)
        if key in pages:
            return httpx.Response(200, json=pages[key])
        return httpx.Response(404, json={"status": 404, "type": "Internal error"})

    http = httpx.Client(transport=httpx.MockTransport(handler))
    wikipedia = Wikipedia(Cache(tmp_path / "c.sqlite"), http=http)
    wikipedia.interval = 0
    return wikipedia, seen


def test_english_is_preferred(tmp_path):
    wikipedia, seen = client(tmp_path)
    assert wikipedia.summary(BLAUDZUN) == {
        "title": "Blaudzun",
        "lang": "en",
        "description": "Dutch singer-songwriter",
        "extract": "Blaudzun is the stage name of the Dutch singer-songwriter Johannes Sigmond "
        "who played for years in various bands and projects before pursuing a solo career in "
        "2006.",
        "url": "https://en.wikipedia.org/wiki/Blaudzun",
        "thumbnail": "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a7/"
        "Blaudzun_bei_Rocken_am_Brocken_2014_06_%28Yellowcard%29.jpg/"
        "330px-Blaudzun_bei_Rocken_am_Brocken_2014_06_%28Yellowcard%29.jpg",
    }
    assert seen == ["www.wikidata.org/Q3043285", "en.wikipedia.org/Blaudzun"]
    wikipedia.summary(BLAUDZUN)
    assert len(seen) == 2, "the second call is served from the cache"


def test_dutch_is_the_fallback(tmp_path):
    wikipedia, seen = client(tmp_path)
    result = wikipedia.summary(DE_KAST)
    assert result["lang"] == "nl" and result["title"] == "De Kast"
    assert result["extract"].startswith("De Kast is een Nederlandse popgroep")
    assert result["thumbnail"] is None
    assert seen == ["www.wikidata.org/Q5240409", "nl.wikipedia.org/De_Kast"]


def test_disambiguation_pages_are_skipped(tmp_path):
    wikipedia, seen = client(tmp_path)
    assert wikipedia.summary({"wikidata": "https://www.wikidata.org/wiki/Q1"})["lang"] == "nl"
    assert seen[1:] == ["en.wikipedia.org/Mercury", "nl.wikipedia.org/De_Kast"]
    assert wikipedia.summary({"wikidata": "https://www.wikidata.org/wiki/Q2"}) is None


def test_no_article_is_cached(tmp_path):
    wikipedia, seen = client(tmp_path)
    links = {"wikidata": "https://www.wikidata.org/wiki/Q404"}
    assert wikipedia.summary(links) is None
    assert wikipedia.summary(links) is None
    assert seen == ["www.wikidata.org/Q404"]


def test_failures_are_not_cached(tmp_path):
    wikipedia, seen = client(tmp_path, status=503)
    assert wikipedia.summary(BLAUDZUN) is None
    assert wikipedia.summary(BLAUDZUN) is None
    assert len(seen) == 2, "asked again after a failure"


def test_a_direct_wikipedia_link_is_used(tmp_path):
    wikipedia, seen = client(tmp_path)
    result = wikipedia.summary({"wikipedia": "https://nl.wikipedia.org/wiki/De_Kast"})
    assert result["title"] == "De Kast"
    assert seen == ["nl.wikipedia.org/De_Kast"]


def test_titles_are_escaped(tmp_path):
    requested = []

    def handler(request):
        requested.append(request.url.raw_path.decode())
        if request.url.host == "www.wikidata.org":
            return httpx.Response(200, json=entity("Q27593", en="AC/DC"))
        return httpx.Response(200, json={**fixture("summary_en_Blaudzun.json"), "title": "AC/DC"})

    wikipedia = Wikipedia(
        Cache(tmp_path / "c.sqlite"), http=httpx.Client(transport=httpx.MockTransport(handler))
    )
    wikipedia.interval = 0
    assert (
        wikipedia.summary({"wikidata": "https://www.wikidata.org/wiki/Q27593"})["title"] == "AC/DC"
    )
    assert requested[1] == "/api/rest_v1/page/summary/AC%2FDC"


def test_without_links_nothing_is_requested(tmp_path):
    wikipedia, seen = client(tmp_path)
    assert wikipedia.summary({"bandcamp": "https://x.bandcamp.com"}) is None
    assert seen == []
