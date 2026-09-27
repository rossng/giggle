"""Blurbs: the few words a presenter says after an artist's name, before the gig.

"Glass Harbour, a Glasgow band pouring shoegaze guitars over a post-punk rhythm section."
The browser adds the gig line ("They play Paradiso on Thursday…") live, so a blurb is
one short, specific descriptor: 8–14 words, never more than `MAX_WORDS`. The model
writes two or three per artist, each from a different angle, so repeat plays can vary.

Blurbs must come from the facts we have (MusicBrainz, Last.fm, Wikipedia), never the
model's memory, which confuses namesakes and invents biographies. Each variant is
checked against the facts it was given (`problems`): numbers, years, count words,
capitalised names (places, people, songs), hype words and every other lower-case word
beyond the common ones listed in blurbs.toml must all appear in them. Variants that fail
are dropped, and artists with too little to go on get no blurb at all (the app then says
just the name and the gig). blurbs.toml also lists artists and blurbs pulled by hand.

The model's raw answers are cached under the prompt version, the model and the facts,
so new facts or a new prompt mean a new answer, and the checks, which run on every
build, can be tightened without asking the model again.
"""

from __future__ import annotations

import json
import re
import sys
import tomllib
from collections.abc import Iterable, Mapping
from concurrent.futures import ThreadPoolExecutor, as_completed
from importlib.resources import files
from typing import Any

from giggle_pipeline.cache import Cache
from giggle_pipeline.llm import LLM, LLMError, cached_answer, store_answer
from giggle_pipeline.text import one_line, plain

TASK = "blurb"

PROMPT_VERSION = 3
BATCH = 8
WORKERS = 4
MAX_VARIANTS = 3
MIN_WORDS, MAX_WORDS = 4, 18
TEXT_CHARS = 600  # of each Wikipedia extract and Last.fm bio

SYSTEM = """You write what a British radio presenter says straight after an artist's name, \
before the gig details: "<name>, <description>." Keep it short, specific and vivid.

For each artist you get the known facts as JSON. Write 2 or 3 different descriptions. Each is \
a noun phrase of 8 to 14 words (never more than 18) that reads naturally after the name and a \
comma, for example:
- "a Glasgow band pouring shoegaze guitars over a post-punk rhythm section"
- "the Belgian trance DJ behind the club anthem Universal Nation"
- "a Lisbon-born singer caught somewhere between jazz and fado"

Give each description a different angle (where they're from, their sound, a known song, who \
they sound like), so the presenter can say something different each time.

Rules:
- Use only the facts given. Never add places, dates, numbers, members, labels, awards, albums \
or songs that aren't in the facts. Leave out anything you're unsure of.
- Be concrete: a place, a sound, a song or a named influence beats filler like "with a modern \
twist", "unique sound" or "international recognition".
- Don't characterise a voice or style ("soulful", "haunting", "elegant") unless the facts do.
- "similar artists" are listeners' comparisons, not influences or collaborators: use them as \
"for fans of X" or "in the vein of X", never "influenced by X".
- Don't guess the line-up size ("four-piece", "trio"), age or gender unless the facts say it.
- No gig details: no venues, days, dates, times, tickets or prices.
- No hype ("legendary", "iconic", "acclaimed", "famous", "best") unless the facts use that word.
- Don't repeat the artist's name. Start with "a", "an", "the" or a possessive.
- British English spelling. Plain spoken words: no brackets, abbreviations, emoji or "&".
- If the facts are too thin, or seem to describe a different artist, return an empty list.

Answer {"artists": [{"id": "<id>", "variants": ["…", "…"]}]}, one entry per artist."""

SCHEMA = {
    "type": "object",
    "properties": {
        "artists": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "variants": {"type": "array", "items": {"type": "string"}, "maxItems": 3},
                },
                "required": ["id", "variants"],
            },
        }
    },
    "required": ["artists"],
}

# --- facts -----------------------------------------------------------------------

COUNTRIES = {
    "AR": ("Argentina", "Argentinian"), "AT": ("Austria", "Austrian"),
    "AU": ("Australia", "Australian"), "BE": ("Belgium", "Belgian"),
    "BG": ("Bulgaria", "Bulgarian"), "BR": ("Brazil", "Brazilian"),
    "CA": ("Canada", "Canadian"), "CH": ("Switzerland", "Swiss"), "CL": ("Chile", "Chilean"),
    "CN": ("China", "Chinese"), "CO": ("Colombia", "Colombian"), "CU": ("Cuba", "Cuban"),
    "CZ": ("Czechia", "Czech"), "DE": ("Germany", "German"), "DK": ("Denmark", "Danish"),
    "EE": ("Estonia", "Estonian"), "EG": ("Egypt", "Egyptian"), "ES": ("Spain", "Spanish"),
    "ET": ("Ethiopia", "Ethiopian"), "FI": ("Finland", "Finnish"), "FR": ("France", "French"),
    "GB": ("United Kingdom", "British"), "GH": ("Ghana", "Ghanaian"),
    "GR": ("Greece", "Greek"), "HR": ("Croatia", "Croatian"), "HU": ("Hungary", "Hungarian"),
    "IE": ("Ireland", "Irish"), "IL": ("Israel", "Israeli"), "IN": ("India", "Indian"),
    "IR": ("Iran", "Iranian"), "IS": ("Iceland", "Icelandic"), "IT": ("Italy", "Italian"),
    "JM": ("Jamaica", "Jamaican"), "JP": ("Japan", "Japanese"),
    "KR": ("South Korea", "South Korean"), "LT": ("Lithuania", "Lithuanian"),
    "LU": ("Luxembourg", "Luxembourgish"), "LV": ("Latvia", "Latvian"),
    "MA": ("Morocco", "Moroccan"), "ML": ("Mali", "Malian"), "MX": ("Mexico", "Mexican"),
    "NG": ("Nigeria", "Nigerian"), "NL": ("Netherlands", "Dutch"),
    "NO": ("Norway", "Norwegian"), "NZ": ("New Zealand", "New Zealand"),
    "PL": ("Poland", "Polish"), "PT": ("Portugal", "Portuguese"),
    "RO": ("Romania", "Romanian"), "RS": ("Serbia", "Serbian"), "RU": ("Russia", "Russian"),
    "SE": ("Sweden", "Swedish"), "SI": ("Slovenia", "Slovenian"),
    "SN": ("Senegal", "Senegalese"), "TR": ("Turkey", "Turkish"),
    "UA": ("Ukraine", "Ukrainian"), "US": ("United States", "American"),
    "ZA": ("South Africa", "South African"),
}  # fmt: skip
REGIONS = {
    "scotland": "Scottish", "england": "English", "wales": "Welsh",
    "northern ireland": "Northern Irish", "united states of america": "American",
    "the netherlands": "Dutch", "holland": "Dutch", "flanders": "Flemish",
    "catalonia": "Catalan", "basque country": "Basque", "québec": "Québécois",
    "quebec": "Québécois",
}  # fmt: skip
_DEMONYM = {name.lower(): dem for name, dem in COUNTRIES.values()} | REGIONS
# Other ways of saying a place that is in the facts.
_ALIASES = {"United Kingdom": "UK Britain", "United States": "USA America"}

JUNK_TAGS = {
    "seen live", "live", "favorites", "favourites", "favorite", "favourite", "love", "loved",
    "awesome", "beautiful", "amazing", "cool", "best", "great", "good", "epic", "sexy",
    "spotify", "albums i own", "check out", "under 2000 listeners", "female vocalists",
    "male vocalists", "all", "radio", "vinyl", "concert", "new", "music", "misc", "other",
    "various", "unknown",
}  # fmt: skip


def _texts(*values: Any) -> list[str]:
    return [v.strip() for v in values if isinstance(v, str) and v.strip()]


def _clip(text: str | None, chars: int = TEXT_CHARS) -> str | None:
    if not text:
        return None
    text = " ".join(text.split())
    if len(text) <= chars:
        return text
    cut = text[:chars]
    end = cut.rfind(". ")
    return cut[: end + 1] if end > chars // 2 else cut.rsplit(" ", 1)[0] + "…"


def _genres(artist: Mapping[str, Any]) -> list[str]:
    mb = artist.get("musicbrainz") or {}
    lf = artist.get("lastfm") or {}
    name = (artist.get("name") or "").lower()
    seen: list[str] = []
    for tag in [*(mb.get("genres") or []), *(lf.get("tags") or []), *(mb.get("tags") or [])]:
        t = " ".join(str(tag).lower().replace("_", " ").split())
        if (
            t
            and t not in seen
            and t not in JUNK_TAGS
            and t != name
            and t not in _DEMONYM
            and t not in {d.lower() for d in _DEMONYM.values()}
            and not re.fullmatch(r"'?\d+s?", t)
            and len(t) <= 24
        ):
            seen.append(t)
    return seen[:6]


def facts(artist: Mapping[str, Any]) -> dict[str, Any]:
    """What the model may use, from an `enrich.describe` record. Empty values left out."""
    mb = artist.get("musicbrainz") or {}
    lf = artist.get("lastfm") or {}
    wp = artist.get("wikipedia") or {}
    match = artist.get("match") or {}
    kind = mb.get("type")
    places = _texts(mb.get("begin_area"), mb.get("area"))
    country = COUNTRIES.get(mb.get("country") or "")
    if country and country[0] not in places:
        places.append(country[0])
    demonyms = []
    for place in places:
        demonym = _DEMONYM.get(place.lower())
        if demonym and demonym not in demonyms:
            demonyms.append(demonym)
    formed = None
    if kind in {"Group", "Orchestra", "Choir"} and mb.get("begin"):
        formed = str(mb["begin"])[:4]
    tracks = [t.get("title") for t in artist.get("top_tracks") or [] if t.get("title")]
    out = {
        "name": artist.get("name"),
        "type": kind,
        "from": ", ".join(dict.fromkeys(places)) or None,
        "nationality": ", ".join(demonyms) or None,
        "formed": formed,
        "summary": match.get("disambiguation") or None,
        "genres": _genres(artist) or None,
        "wikipedia description": wp.get("description") or None,
        "wikipedia": _clip(wp.get("extract")),
        "last.fm bio": _clip(lf.get("bio")),
        "similar artists": (lf.get("similar") or [])[:5] or None,
        "popular songs": tracks[:3] or None,
    }
    return {k: v for k, v in out.items() if v}


def enough(f: Mapping[str, Any]) -> bool:
    """Whether there's enough to say something specific. Otherwise the app says just the
    name and the gig, which is better than a blurb padded out with generalities."""
    prose = any(k in f for k in ("wikipedia", "last.fm bio", "wikipedia description"))
    score = 2 * prose + sum(
        k in f for k in ("from", "summary", "similar artists", "popular songs", "formed")
    )
    score += len(f.get("genres") or []) >= 2
    return bool(f.get("genres") or prose) and score >= 2


# --- checks ----------------------------------------------------------------------

_NUMBER_WORDS = {
    "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
    "twelve", "thirteen", "fifteen", "twenty", "thirty", "forty", "fifty", "hundred",
    "thousand", "million", "millions", "billion", "dozen", "dozens", "second", "third",
    "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "decade", "decades",
    "sixties", "seventies", "eighties", "nineties", "noughties", "duo", "trio", "quartet",
    "quintet", "sextet", "septet", "octet", "debut",
}  # fmt: skip
_HYPE = {
    "legend", "legendary", "legends", "iconic", "icon", "acclaimed", "critically", "renowned",
    "famous", "celebrated", "beloved", "seminal", "pioneer", "pioneers", "pioneering",
    "influential", "best", "greatest", "biggest", "finest", "award", "awards", "grammy",
    "chart", "charts", "platinum", "hit", "hits", "smash", "cult", "star", "stars",
    "superstar", "sensation", "massive", "huge", "genius", "virtuoso", "masterful",
    "breakthrough", "viral", "sold-out", "stellar", "unmissable", "must-see",
}  # fmt: skip
# Words about how someone sounds that models reach for when the facts don't say.
_STYLE = {
    "soulful", "haunting", "lyrical", "fluid", "poetic", "introspective", "heartfelt",
    "emotive", "emotional", "cinematic", "dynamic", "bold", "youthful", "rich", "melodic",
    "genre-defying", "elegant", "expressive", "atmospheric", "ethereal", "lush", "raw",
    "gritty", "dreamy", "hypnotic", "infectious", "catchy", "powerful", "energetic",
    "intimate", "timeless", "soaring", "moody", "brooding", "quirky", "eclectic",
    "innovative", "unique", "distinctive", "signature", "twist", "vibrant", "captivating",
    "mesmerising", "mesmerizing", "evocative", "sultry", "silky", "smooth", "velvety",
    "tender", "fiery", "explosive", "electrifying", "uplifting", "anthemic", "irresistible",
    "addictive", "stunning", "gorgeous", "breathtaking", "spellbinding",
}  # fmt: skip
_GIG_WORDS = {
    "tonight", "tomorrow", "ticket", "tickets", "euro", "euros", "price", "prices", "sold",
    "doors", "gig", "gigs", "venue", "headlining", "headliner", "supporting", "monday",
    "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january",
    "february", "march", "april", "june", "july", "august", "september", "october",
    "november", "december", "weekend",
}  # fmt: skip
_MUST_BE_IN_FACTS = _NUMBER_WORDS | _HYPE | _STYLE
_SETTINGS = tomllib.loads(files("giggle_pipeline").joinpath("blurbs.toml").read_text())
# Lower-case words allowed without the facts (blurbs.toml); all others must be in them.
_COMMON = frozenset(_SETTINGS["words"].split()) - _MUST_BE_IN_FACTS - _GIG_WORDS
BLOCKED_ARTISTS = frozenset(_SETTINGS["blocked"]["artists"])
BLOCKED_BLURBS = frozenset(plain(t) for t in _SETTINGS["blocked"]["blurbs"])
_BRITISH = {
    "color": "colour", "colors": "colours", "colorful": "colourful", "favorite": "favourite",
    "favorites": "favourites", "flavor": "flavour", "flavors": "flavours", "honor": "honour",
    "humor": "humour", "rumor": "rumour", "center": "centre", "centered": "centred",
    "theater": "theatre", "gray": "grey", "harbor": "harbour", "neighbor": "neighbour",
    "neighborhood": "neighbourhood", "savior": "saviour", "labor": "labour",
    "fervor": "fervour", "glamor": "glamour", "vapor": "vapour", "traveling": "travelling",
    "jewelry": "jewellery", "catalog": "catalogue", "dialog": "dialogue",
}  # fmt: skip
_KEEP_IZE = ("capsiz", "oversiz", "downsiz", "supersiz", "outsiz")  # size, prize: stem too short


def haystack(f: Mapping[str, Any]) -> str:
    """Every word in the facts, plus other names for their places, space-padded."""
    extra = [_ALIASES.get(p.strip(), "") for p in (f.get("from") or "").split(",")]
    return f" {plain(json.dumps(f, ensure_ascii=False) + ' ' + ' '.join(extra))} "


def _has(words: str, hay: str) -> bool:
    p = plain(words)
    return bool(p) and f" {p} " in hay


def tidy(text: str, name: str) -> str:
    """The descriptor as it should follow "<name>, ": trimmed, no leading name or
    verb, lower-case article, British spelling, no final full stop."""
    t = " ".join(str(text).replace("’", "'").replace("‘", "'").split())
    t = t.replace("“", '"').replace("”", '"').rstrip(".!;:, ")
    while len(t) > 1 and t[0] == t[-1] and t[0] in "\"'":  # wrapped in quotes
        t = t[1:-1].strip().rstrip(".!;:, ")
    if name and plain(t).startswith(plain(name) + " "):
        t = t[len(name) :].lstrip(" ,:—-")
    t = re.sub(r"^(?:is|are|was|were)\s+", "", t, flags=re.I)
    t = re.sub(r"^(A|An|The)\b", lambda m: m.group(1).lower(), t)
    # "a Amsterdam-born…", but "a European", "a unique", "a one-off".
    t = re.sub(r"^a (?=[aeiou])(?!uni|use|usu|uru|ukr|eu|one\b|once)", "an ", t, flags=re.I)
    t = re.sub(r"\s+&\s+", " and ", t)
    return re.sub(r"[A-Za-z]+", _british, t)


def _british(m: re.Match[str]) -> str:
    word = m.group(0)
    low = word.lower()
    uk = _BRITISH.get(low)
    if uk is None:
        ize = re.fullmatch(r"([a-z]{3,})iz(e|es|ed|er|ers|ing|ation|ations)", low)
        if ize is None or low.startswith(_KEEP_IZE):
            return word
        uk = f"{ize.group(1)}is{ize.group(2)}"
    return uk.capitalize() if word[0].isupper() else uk


def problems(text: str, f: Mapping[str, Any], hay: str | None = None) -> list[str]:
    """Why a (tidied) descriptor can't be used; empty if it can."""
    hay = hay if hay is not None else haystack(f)
    out = []
    words = text.split()
    if len(words) > MAX_WORDS:
        out.append(f"{len(words)} words")
    if len(words) < MIN_WORDS:
        out.append("too short")
    if re.search(r"[€£$%@#*_()\[\]{}<>|/\\]", text):
        out.append("symbols")
    name = plain(f.get("name") or "")
    if name and f" {name} " in f" {plain(text)} ":
        out.append("repeats the name")
    known_numbers = set(re.findall(r"\d+", hay))
    for digits in re.findall(r"\d+", text):
        if digits not in known_numbers:
            out.append(f"number {digits}")
    tokens = re.findall(r"[^\s]+", text)
    for token in tokens:
        bare = token.strip("\"'.,;:!?")
        bare = re.sub(r"'s$", "", bare)
        if "-" in bare and bare.lower() in _MUST_BE_IN_FACTS and not _has(bare, hay):
            out.append(f"unsupported {bare}")  # "genre-defying"
        for part in bare.split("-"):
            low = part.lower()
            if not part:
                continue
            if low in _GIG_WORDS:
                out.append(f"gig detail {part}")
            elif low in _MUST_BE_IN_FACTS and not _has(low, hay):
                out.append(f"unsupported {part}")
            elif part[0].isupper() and not _has(part, hay):
                out.append(f"unknown name {part}")
            elif part[0].islower():
                out.extend(f"word {w}" for w in re.findall(r"[a-z]{2,}", low) if not _known(w, hay))
    return out


def _forms(word: str) -> list[str]:
    """`word` and the words it may be a form of: "guitars", "blending", "rooted"…"""
    out = [word, word + "s"]
    words = [word]
    if word.endswith("s") and not word.endswith("ss"):  # "recordings" → "recording"…
        words.append(word[:-1])
    for w in words:
        for end, stems in _ENDINGS:
            if w.endswith(end) and len(w) - len(end) >= 2:
                base = w[: -len(end)]
                out += [base + s for s in stems]
                if len(base) >= 4 and base[-1] == base[-2]:  # "drumming", "mapped"
                    out.append(base[:-1])
    return out


_ENDINGS = (
    ("ies", ("y",)),
    ("es", ("", "e")),
    ("s", ("",)),
    ("ing", ("", "e")),
    ("ed", ("", "e")),
    ("er", ("", "e")),
    ("ly", ("",)),
)


def _known(word: str, hay: str) -> bool:
    """Whether a lower-case word may be said: common (blurbs.toml) or from the facts."""
    return any(w in _COMMON or f" {w} " in hay for w in _forms(word))


def usable(variants: Iterable[Any], f: Mapping[str, Any]) -> list[str]:
    """The model's variants that pass the checks, tidied, without repeats, at most
    `MAX_VARIANTS`."""
    hay = haystack(f)
    kept: list[str] = []
    seen: set[str] = set()
    for raw in variants:
        if not isinstance(raw, str):
            continue
        text = tidy(raw, f.get("name") or "")
        if plain(text) in BLOCKED_BLURBS:
            continue
        if text and plain(text) not in seen and not problems(text, f, hay):
            seen.add(plain(text))
            kept.append(text)
    return kept[:MAX_VARIANTS]


# --- the model -------------------------------------------------------------------


def _ask(llm: LLM, batch: list[tuple[str, dict[str, Any]]]) -> dict[str, list[Any]]:
    """Raw variants per artist key for one batch (runs on a worker thread)."""
    ids = {f"a{i + 1}": key for i, (key, _) in enumerate(batch)}
    items = [{"id": f"a{i + 1}", **f} for i, (_, f) in enumerate(batch)]
    user = json.dumps(items, ensure_ascii=False)
    answer = llm.json(TASK, SYSTEM, user, SCHEMA)
    rows = answer.get("artists") if isinstance(answer, dict) else None
    if not isinstance(rows, list):
        raise LLMError(f"unexpected answer: {str(answer)[:200]}")
    out = {}
    for row in rows:
        if isinstance(row, dict) and row.get("id") in ids and isinstance(row.get("variants"), list):
            out[ids[row["id"]]] = row["variants"]
    return out


def write_blurbs(
    artists: Mapping[str, Mapping[str, Any]],
    llm: LLM | None,
    cache: Cache,
    order: Iterable[str] | None = None,
    workers: int = WORKERS,
) -> dict[str, list[str]]:
    """Checked descriptor variants per artist key (possibly []), for the artists in
    `order` (default: all, as given; pass soonest gig first so a spent budget leaves
    next year's artists waiting, not next week's). Cached answers are reused; the rest go
    to the model in batches of `BATCH`, as many as its budget allows
    (`llm.remaining`). Artists the model wasn't asked about this run are left out of
    the result."""
    keys = [k for k in (order if order is not None else artists) if k in artists]
    result: dict[str, list[str]] = {}
    todo: list[tuple[str, dict[str, Any]]] = []
    all_facts: dict[str, dict[str, Any]] = {}
    for key in dict.fromkeys(keys):
        f = all_facts[key] = facts(artists[key])
        if not enough(f) or key in BLOCKED_ARTISTS:
            result[key] = []
            continue
        hit = cached_answer(cache, TASK, llm, PROMPT_VERSION, f)
        if hit is not None:
            result[key] = usable(hit[0], f)
        else:
            todo.append((key, f))

    batches = [todo[i : i + BATCH] for i in range(0, len(todo), BATCH)]
    batches = batches[: llm.remaining(TASK)] if llm is not None else []
    if not batches:
        if todo and llm is not None:
            print(f"blurbs: no requests left for {len(todo)} artists this run", file=sys.stderr)
        return result
    failed = rejected = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {pool.submit(_ask, llm, batch): batch for batch in batches}
        for future in as_completed(futures):  # cache writes stay on this thread
            try:
                answers = future.result()
            except (LLMError, AttributeError, KeyError, TypeError, ValueError) as exc:
                failed += 1
                if failed <= 3:
                    print(f"blurbs: batch failed: {one_line(exc)}", file=sys.stderr)
                continue
            for key, f in futures[future]:
                raw = answers.get(key)
                if raw is None:
                    continue  # not answered: ask again next run
                raw = [v for v in raw if isinstance(v, str)][: MAX_VARIANTS + 2]
                store_answer(cache, TASK, llm, PROMPT_VERSION, f, raw)
                result[key] = usable(raw, f)
                rejected += len(raw) - len(result[key])
    asked = sum(len(b) for b in batches)
    print(
        f"blurbs: asked about {asked} artists in {len(batches)} requests "
        f"({failed} failed, {rejected} variants rejected); {len(todo) - asked} left for later",
        file=sys.stderr,
    )
    return result


def fake_answer(task: str, user: str) -> dict[str, Any]:
    """FakeLLM stand-in for offline runs: a descriptor pieced together from the facts."""
    items = json.loads(user)
    out = []
    for item in items:
        genres = item.get("genres") or []
        noun = {"Group": "band", "Person": "artist"}.get(item.get("type"), "act")
        variants = []
        place = (item.get("from") or "").split(",")[0].strip()
        if genres and place:
            variants.append(f"a {' and '.join(genres[:2])} {noun} from {place}")
        if len(genres) >= 2 and item.get("similar artists"):
            similar = item["similar artists"][0]
            variants.append(f"a {genres[0]} {noun} for anyone who likes {similar}")
        out.append({"id": item["id"], "variants": variants})
    return {"artists": out}
