"""Pre-rendered artist introductions: "<name>, <blurb>." in the artist's announcer voice.

The browser says the gig line ("They play Paradiso on Thursday…") live after the clip,
so a clip holds only the name and one blurb variant. Each clip's exact length goes into
artists.json: the presenter plans its timing around it (see packages/radio-core).

Clips go to `<site>/voice/<hash>.mp3`, published with the site. A clip that exists is
never rendered again, and a night's rendering is capped: the first variant of every
artist comes before anyone's second, soonest gig first, so a spent budget leaves the
far-off artists and the spare variants for the next night.
"""

from __future__ import annotations

import sys
import time
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

from giggle_pipeline.voice import (
    ANNOUNCERS,
    DEFAULT_MODEL_DIR,
    LazyKokoro,
    Lexicon,
    Synthesizer,
    Voice,
    VoiceError,
    announcer_for,
    mp3_seconds,
)

MAX_RENDERS = 300  # a few seconds each on a CI runner's CPU
CLIP_DIR = "voice"


def clip_text(name: str, blurb: str) -> str:
    return f"{name.strip()}, {blurb.strip().rstrip('.')}."


def render_intros(
    artists: Mapping[str, Mapping[str, Any]],
    blurbs: Mapping[str, Sequence[str]],
    order: Iterable[str],
    site_dir: Path,
    max_renders: int = MAX_RENDERS,
    synthesizer: Synthesizer | None = None,
    lexicon: Lexicon | None = None,
    model_dir: Path = DEFAULT_MODEL_DIR,
    speed: float = 1.0,
) -> dict[str, list[dict[str, Any]]]:
    """{artist key: [{text, file, seconds, voice}]} for the artists in `order` (soonest gig
    first) that have blurbs, one entry per variant with a clip, in the blurbs' order.
    `file` is relative to `site_dir`. Existing clips are reused for free; at most
    `max_renders` new ones are made. Without the voice extra or the model, only existing
    clips are returned."""
    lexicon = lexicon if lexicon is not None else Lexicon.load()
    synth = synthesizer if synthesizer is not None else LazyKokoro(model_dir)
    voices = {v: Voice(model_dir, v, speed, lexicon, synth) for v in ANNOUNCERS}
    out_dir = site_dir / CLIP_DIR
    keys = [k for k in dict.fromkeys(order) if k in artists and blurbs.get(k)]
    # Breadth first: every artist's first variant, then every artist's second, and so on.
    depth = max((len(blurbs[k]) for k in keys), default=0)
    wanted = [(k, i) for i in range(depth) for k in keys if i < len(blurbs[k])]

    found: dict[tuple[str, int], dict[str, Any]] = {}
    rendered = skipped = 0
    audio_seconds = render_seconds = 0.0
    can_render = max_renders > 0
    for key, i in wanted:
        voice = voices[announcer_for(key)]
        text = clip_text(artists[key]["name"], blurbs[key][i])
        path = voice.path_for(text, out_dir)
        if not path.exists():
            if not can_render or rendered >= max_renders:
                skipped += 1
                continue
            started = time.perf_counter()
            try:
                voice.render(text, out_dir)
            except VoiceError as exc:
                print(f"clips: can't render, using existing clips only: {exc}", file=sys.stderr)
                can_render = False
                skipped += 1
                continue
            render_seconds += time.perf_counter() - started
            rendered += 1
            audio_seconds += mp3_seconds(path)
        found[key, i] = {
            "text": text,
            "file": f"{CLIP_DIR}/{path.name}",
            "seconds": round(mp3_seconds(path), 2),
            "voice": voice.voice,
        }

    result: dict[str, list[dict[str, Any]]] = {}
    for key in keys:
        clips = [found[key, i] for i in range(len(blurbs[key])) if (key, i) in found]
        if clips:
            result[key] = clips
    speed_note = f" in {render_seconds:.0f} s" if rendered else ""
    print(
        f"clips: {rendered} rendered ({audio_seconds:.0f} s of audio{speed_note}), "
        f"{len(found) - rendered} reused, {skipped} left for later",
        file=sys.stderr,
    )
    return result
