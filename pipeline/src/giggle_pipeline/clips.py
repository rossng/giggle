"""Pre-rendered artist introductions: "<name>, <blurb>." in the artist's announcer voice.

The browser says the gig line ("They play Paradiso on Thursday…") live after the clip,
so a clip holds only the name and one blurb variant. Each clip's exact length goes into
artists.json: the presenter plans its timing around it (see packages/radio-core).

Clips are rendered into the clip cache (`data/cache/voice/<hash>.mp3`), which travels
between nightly runs with the rest of the cache, and the ones artists.json uses are
copied to `<site>/voice/`. A clip that exists is never rendered again. A night's
rendering is capped by count and by time: the first variant of every artist comes before
anyone's second, soonest gig first, so a spent budget leaves the far-off artists and the
spare variants for the next night. Cached clips nobody has used for `KEEP_DAYS` are
deleted; `referenced.json` in the cache remembers when each was last used.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from giggle_pipeline.voice import (
    ANNOUNCERS,
    DEFAULT_MODEL_DIR,
    KokoroSynthesizer,
    Lexicon,
    Synthesizer,
    Voice,
    VoiceError,
    announcer_for,
    mp3_seconds,
)

MAX_RENDERS = 300  # a few seconds each on a CI runner's CPU
MAX_SECONDS = 20 * 60  # of rendering per run, well inside the nightly job's timeout
KEEP_DAYS = 60
CLIP_DIR = "voice"  # in the site
MANIFEST = "referenced.json"  # in the clip cache: {file name: date last used}
_CLIP = re.compile(r"^[0-9a-f]{20}\.mp3$")


@dataclass
class Intros:
    clips: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    rendered: int = 0
    left: int = 0  # clips wanted but not rendered this run
    error: str | None = None  # why rendering stopped, if the voice failed


def clip_text(name: str, blurb: str) -> str:
    return f"{name.strip()}, {blurb.strip().rstrip('.')}."


def render_intros(
    artists: Mapping[str, Mapping[str, Any]],
    blurbs: Mapping[str, Sequence[str]],
    order: Iterable[str],
    cache_dir: Path,
    site_dir: Path,
    today: date,
    max_renders: int = MAX_RENDERS,
    max_seconds: float = MAX_SECONDS,
    synthesizer: Synthesizer | None = None,
    lexicon: Lexicon | None = None,
    model_dir: Path = DEFAULT_MODEL_DIR,
    speed: float = 1.0,
    clock: Callable[[], float] = time.monotonic,
) -> Intros:
    """Clips for the artists in `order` (soonest gig first) that have blurbs:
    `clips` is {artist key: [{text, file, seconds, voice}]}, one entry per variant with a
    clip, in the blurbs' order; `file` is relative to `site_dir`. Existing clips are reused
    for free; at most `max_renders` new ones are made, in at most `max_seconds`. Without
    the voice extra or the model, only existing clips are returned."""
    adopt_site_clips(site_dir / CLIP_DIR, cache_dir)
    lexicon = lexicon if lexicon is not None else Lexicon.load()
    synth = synthesizer if synthesizer is not None else KokoroSynthesizer(model_dir)
    voices = {v: Voice(model_dir, v, speed, lexicon, synth) for v in ANNOUNCERS}
    keys = [k for k in dict.fromkeys(order) if k in artists and blurbs.get(k)]
    # Breadth first: every artist's first variant, then every artist's second, and so on.
    depth = max((len(blurbs[k]) for k in keys), default=0)
    wanted = [(k, i) for i in range(depth) for k in keys if i < len(blurbs[k])]

    out = Intros()
    found: dict[tuple[str, int], dict[str, Any]] = {}
    audio_seconds = 0.0
    started = clock()
    stop = "" if max_renders > 0 else "no renders this run"
    for key, i in wanted:
        voice = voices[announcer_for(key)]
        text = clip_text(artists[key]["name"], blurbs[key][i])
        path = voice.path_for(text, cache_dir)
        if not path.exists():
            if not stop and out.rendered >= max_renders:
                stop = f"the limit of {max_renders} clips"
            if not stop and clock() - started >= max_seconds:
                stop = f"the {max_seconds / 60:g}-minute time limit"
            if stop:
                out.left += 1
                continue
            try:
                voice.render(text, cache_dir)
            except VoiceError as exc:
                print(f"clips: can't render, using existing clips only: {exc}", file=sys.stderr)
                out.error = stop = str(exc)
                out.left += 1
                continue
            out.rendered += 1
            audio_seconds += mp3_seconds(path)
        found[key, i] = {
            "text": text,
            "file": f"{CLIP_DIR}/{path.name}",
            "seconds": round(mp3_seconds(path), 2),
            "voice": voice.voice,
        }

    for key in keys:
        clips = [found[key, i] for i in range(len(blurbs[key])) if (key, i) in found]
        if clips:
            out.clips[key] = clips
    used = {Path(c["file"]).name for c in found.values()}
    publish(used, cache_dir, site_dir / CLIP_DIR)
    pruned = prune(cache_dir, used, today)
    took = f" in {clock() - started:.0f} s" if out.rendered else ""
    print(
        f"clips: {out.rendered} rendered ({audio_seconds:.0f} s of audio{took}), "
        f"{len(found) - out.rendered} reused, {out.left} left for later"
        + (f" ({stop})" if stop and out.left else "")
        + f", {pruned} unused ones deleted",
        file=sys.stderr,
    )
    return out


def adopt_site_clips(site_clips: Path, cache_dir: Path) -> None:
    """Clips from before the clip cache existed, or rendered elsewhere, join the cache."""
    if not site_clips.is_dir():
        return
    for path in site_clips.iterdir():
        if _CLIP.match(path.name) and not (cache_dir / path.name).exists():
            cache_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, cache_dir / path.name)


def publish(used: set[str], cache_dir: Path, site_clips: Path) -> None:
    """Make `site_clips` hold exactly the clips in `used`, copied from the cache."""
    site_clips.mkdir(parents=True, exist_ok=True)
    for path in site_clips.iterdir():
        if _CLIP.match(path.name) and path.name not in used:
            path.unlink()  # it's in the cache (adopt_site_clips)
    for name in used:
        target = site_clips / name
        if not target.exists() or target.stat().st_size != (cache_dir / name).stat().st_size:
            shutil.copy2(cache_dir / name, target)


def prune(cache_dir: Path, used: set[str], today: date) -> int:
    """Note today as the last use of `used`, and delete cached clips unused for
    `KEEP_DAYS`. Clips the manifest doesn't know yet count as used today."""
    if not cache_dir.is_dir():
        return 0
    manifest_path = cache_dir / MANIFEST
    try:
        manifest = json.loads(manifest_path.read_text())
    except (FileNotFoundError, ValueError):
        manifest = {}
    cutoff = (today - timedelta(days=KEEP_DAYS)).isoformat()
    kept, pruned = {}, 0
    for path in sorted(cache_dir.iterdir()):
        if not _CLIP.match(path.name):
            continue
        last = manifest.get(path.name, today.isoformat())
        if path.name in used:
            last = max(last, today.isoformat())
        if last < cutoff:
            path.unlink()
            pruned += 1
        else:
            kept[path.name] = last
    manifest_path.write_text(json.dumps(kept, indent=0, sort_keys=True) + "\n")
    return pruned
