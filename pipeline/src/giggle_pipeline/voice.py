"""Announcer clips: Kokoro-82M text-to-speech in British English voices, saved as MP3.

A clip is named after a hash of everything that shapes its sound: the text as spoken
(after the pronunciation lexicon), the voice, the model, the speed and the encoding.
`Voice.render` returns the existing file when there is one, so unchanged text is never
re-rendered or re-uploaded, and the model is only loaded when a clip is missing.

Names are fixed up by `pronunciation.toml`: a match becomes `[Name](/ipa/)`, the inline
phoneme markup of misaki (Kokoro's own G2P). kokoro-onnx phonemizes with espeak-ng and
has no markup of its own, so `KokoroSynthesizer` phonemizes the plain stretches and
splices the lexicon's phonemes in between. The model runs on CPU with ONNX Runtime, from
the `voice` extra: `uv run --package giggle-pipeline --extra voice giggle-voice-samples`.
Model files are downloaded on first use to data/cache/models/ and never committed.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import os
import re
import shutil
import sys
import time
import tomllib
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

import httpx
import lameenc
import numpy as np

from giggle_pipeline.cache import key_for

if TYPE_CHECKING:
    from numpy.typing import NDArray

LEXICON_PATH = Path(__file__).with_name("pronunciation.toml")
DEFAULT_MODEL_DIR = Path("data/cache/models")

# Kokoro v1.0's British English voices. Its VOICES.md grades them roughly: emma B-,
# isabella, george and fable C, the rest D, mostly by how much training audio each had.
BRITISH_VOICES = (
    "bf_emma",
    "bf_isabella",
    "bf_alice",
    "bf_lily",
    "bm_george",
    "bm_fable",
    "bm_lewis",
    "bm_daniel",
)

# The announcers: two presenters, chosen by ear on 2026-09-26. Each artist always gets the
# same one (see `announcer_for`), so clips stay cacheable and voices alternate between
# artists as the radio moves on.
ANNOUNCERS = ("bf_isabella", "bm_fable")


def announcer_for(artist_key: str) -> str:
    """The announcer voice for an artist: stable per artist, roughly half each."""
    digest = hashlib.sha256(artist_key.encode()).digest()
    return ANNOUNCERS[digest[0] % len(ANNOUNCERS)]


SAMPLE_RATE = 24_000
BITRATE_KBPS = 48
TARGET_RMS_DBFS = -18.0  # speech level, measured over voiced frames only
PEAK_CEILING_DBFS = -1.0
# Bump when the audio processing or encoding changes, to re-render every clip.
RENDER_VERSION = 1

RELEASE_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"


@dataclass(frozen=True)
class ModelFile:
    name: str
    size: int
    sha256: str


# fp32 is the default: on an M-series Mac it renders ~3x faster than int8 (ONNX
# Runtime's dynamic int8 kernels are slow on CPU) and ~1.5x faster than fp16.
MODELS = {
    "fp32": ModelFile(
        "kokoro-v1.0.onnx",
        325_532_387,
        "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
    ),
    "fp16": ModelFile(
        "kokoro-v1.0.fp16.onnx",
        177_464_787,
        "c1610a859f3bdea01107e73e50100685af38fff88f5cd8e5c56df109ec880204",
    ),
    "int8": ModelFile(
        "kokoro-v1.0.int8.onnx",
        92_361_271,
        "6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb",
    ),
}
VOICES_FILE = ModelFile(
    "voices-v1.0.bin",
    28_214_398,
    "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
)


class VoiceError(Exception):
    pass


# --- pronunciation ---------------------------------------------------------------

_MARKUP = re.compile(r"\[([^\]]+)\]\(/([^/]+)/\)")
_VOICELESS = set("ptkfθ")
_SIBILANTS = set("szʃʒ")


def _possessive(ipa: str) -> str:
    last = ipa.rstrip("ˈˌː ")[-1:]
    if last in _SIBILANTS:
        return ipa + "ɪz"
    return ipa + ("s" if last in _VOICELESS else "z")


@dataclass(frozen=True)
class Entry:
    written: str
    ipa: str
    match_case: bool = False


@dataclass
class Lexicon:
    entries: list[Entry] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path = LEXICON_PATH) -> Lexicon:
        names = tomllib.loads(path.read_text())["names"]
        entries = []
        for written, value in names.items():
            if isinstance(value, str):
                entries.append(Entry(written, value))
            else:
                entries.append(Entry(written, value["ipa"], bool(value.get("match_case"))))
        return cls(entries)

    def __post_init__(self) -> None:
        # Longest first, so a multi-word name wins over the words inside it.
        ordered = sorted(enumerate(self.entries), key=lambda e: -len(e[1].written))
        alternatives = []
        for i, entry in ordered:
            words = r"\s+".join(re.escape(w) for w in entry.written.split())
            flag = "" if entry.match_case else "(?i:"
            alternatives.append(f"(?P<e{i}>{flag}{words}{')' if flag else ''})")
        body = "|".join(alternatives) or r"(?!)"
        # Whole words only; a possessive 's is taken along to get its ending right.
        self._pattern = re.compile(rf"(?<!\w)(?:{body})(?P<poss>'s)?(?!\w)")

    def apply(self, text: str) -> tuple[str, dict[str, str]]:
        """The text with each known name replaced by `[Name](/ipa/)`, and the entries
        used ({written form: ipa}), which go into the clip hash."""
        text = text.replace("’", "'")
        used: dict[str, str] = {}

        def sub(m: re.Match[str]) -> str:
            entry = self.entries[_which(m)]
            used[entry.written] = entry.ipa
            ipa = _possessive(entry.ipa) if m.group("poss") else entry.ipa
            return f"[{m.group(0)}](/{ipa}/)"

        return self._pattern.sub(sub, text), dict(sorted(used.items()))


def _which(m: re.Match[str]) -> int:
    for name, value in m.groupdict().items():
        if name != "poss" and value is not None:
            return int(name[1:])
    raise AssertionError("no lexicon entry matched")


# --- synthesis -------------------------------------------------------------------


def splice_phonemes(text: str, phonemize: Callable[[str], str]) -> str:
    """Phonemes for text with `[word](/ipa/)` markup: `phonemize` handles the plain
    stretches, the markup's phonemes go in as they are, and spacing follows the text."""
    out, pos = "", 0
    for m in [*_MARKUP.finditer(text), None]:
        plain = text[pos : m.start() if m else len(text)]
        if plain.strip():
            out += " " * plain[0].isspace() + phonemize(plain) + " " * plain[-1].isspace()
        else:
            out += " " * bool(plain)
        if m:
            out, pos = out + m.group(2), m.end()
    return " ".join(out.split())


class Synthesizer(Protocol):
    name: str  # identifies the model, so a different model gives different clip names
    sample_rate: int

    def synthesize(self, text: str, voice: str, speed: float) -> NDArray[np.float32]:
        """Mono float audio for `text`, which may contain `[word](/ipa/)` markup."""
        ...


def ensure_model(model_dir: Path, variant: str = "fp32") -> tuple[Path, Path]:
    """The model and voices files, downloaded and checksummed if not already there."""
    if variant not in MODELS:
        raise VoiceError(f"unknown model variant {variant!r}, choose from {', '.join(MODELS)}")
    return _fetch(model_dir, MODELS[variant]), _fetch(model_dir, VOICES_FILE)


def _fetch(model_dir: Path, spec: ModelFile) -> Path:
    path = model_dir / spec.name
    if path.exists() and path.stat().st_size == spec.size:
        return path
    model_dir.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(path.suffix + ".part")
    digest = hashlib.sha256()
    print(f"downloading {spec.name} ({spec.size / 1e6:.0f} MB)", file=sys.stderr)
    with (
        httpx.stream("GET", RELEASE_URL + spec.name, follow_redirects=True, timeout=60) as r,
        partial.open("wb") as out,
    ):
        r.raise_for_status()
        for chunk in r.iter_bytes(1 << 20):
            digest.update(chunk)
            out.write(chunk)
    if partial.stat().st_size != spec.size or digest.hexdigest() != spec.sha256:
        partial.unlink()
        raise VoiceError(f"{spec.name}: download doesn't match the expected size and checksum")
    partial.replace(path)
    return path


class KokoroSynthesizer:
    """Kokoro-82M v1.0 through kokoro-onnx, on CPU, phonemized as British English."""

    lang = "en-gb"

    def __init__(self, model_dir: Path = DEFAULT_MODEL_DIR, variant: str = "fp32") -> None:
        try:
            from kokoro_onnx import Kokoro
        except ImportError as exc:
            hint = "uv run --package giggle-pipeline --extra voice …"
            raise VoiceError(f"kokoro-onnx isn't installed: {hint}") from exc
        model, voices = ensure_model(model_dir, variant)
        self.tts = Kokoro(str(model), str(voices))
        self.name = f"kokoro-v1.0-{variant}/{self.lang}"
        self.sample_rate = SAMPLE_RATE

    def voices(self) -> list[str]:
        return self.tts.get_voices()

    def phonemes(self, text: str) -> str:
        return splice_phonemes(text, lambda t: self.tts.tokenizer.phonemize(t, self.lang))

    def synthesize(self, text: str, voice: str, speed: float) -> NDArray[np.float32]:
        audio, _ = self.tts.create(
            self.phonemes(text), voice, speed=speed, lang=self.lang, is_phonemes=True
        )
        return np.asarray(audio, dtype=np.float32)


class LazyKokoro:
    """A `KokoroSynthesizer` that loads the model on first use, so several `Voice`s can
    share one model and a run that renders nothing never loads it. Named like the real
    one, so clip hashes are the same either way."""

    def __init__(self, model_dir: Path = DEFAULT_MODEL_DIR, variant: str = "fp32") -> None:
        self.model_dir, self.variant = model_dir, variant
        self.name = f"kokoro-v1.0-{variant}/{KokoroSynthesizer.lang}"
        self.sample_rate = SAMPLE_RATE
        self._tts: KokoroSynthesizer | None = None

    def synthesize(self, text: str, voice: str, speed: float) -> NDArray[np.float32]:
        if self._tts is None:
            self._tts = KokoroSynthesizer(self.model_dir, self.variant)
        return self._tts.synthesize(text, voice, speed)


# --- audio -----------------------------------------------------------------------


def normalise(audio: NDArray[np.float32], sample_rate: int) -> NDArray[np.float32]:
    """Bring speech to a steady level (RMS over voiced 20 ms frames, pauses ignored),
    keep peaks under the ceiling, and fade the ends so there's no click."""
    audio = np.asarray(audio, dtype=np.float32).ravel()
    if not audio.size or not np.any(audio):
        return audio
    frame = max(1, sample_rate // 50)
    frames = (
        audio[: len(audio) // frame * frame].reshape(-1, frame)
        if len(audio) >= frame
        else audio[None, :]
    )
    rms = np.sqrt(np.mean(frames**2, axis=1))
    voiced = rms[rms >= rms.max() * 10 ** (-30 / 20)]  # within 30 dB of the loudest frame
    level = float(np.sqrt(np.mean(voiced**2)))
    gain = 10 ** (TARGET_RMS_DBFS / 20) / level
    gain = min(gain, 10 ** (PEAK_CEILING_DBFS / 20) / float(np.abs(audio).max()))
    out = audio * gain
    fade = min(len(out) // 2, sample_rate // 200)
    if fade:
        ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
        out[:fade] *= ramp
        out[-fade:] *= ramp[::-1]
    return out


def encode_mp3(audio: NDArray[np.float32], sample_rate: int) -> bytes:
    pad = np.zeros(sample_rate // 10, dtype=np.float32)  # 100 ms either side
    pcm = np.concatenate([pad, audio, pad])
    pcm16 = (np.clip(pcm, -1.0, 1.0) * 32767).astype("<i2")
    encoder = lameenc.Encoder()
    encoder.set_channels(1)
    encoder.set_in_sample_rate(sample_rate)
    encoder.set_bit_rate(BITRATE_KBPS)
    encoder.set_quality(2)
    return bytes(encoder.encode(pcm16.tobytes()) + encoder.flush())


# --- clips -----------------------------------------------------------------------


class Voice:
    """Renders announcer clips in one voice, cached by content hash."""

    def __init__(
        self,
        model_dir: Path = DEFAULT_MODEL_DIR,
        voice: str = "bf_emma",
        speed: float = 1.0,
        lexicon: Lexicon | None = None,
        synthesizer: Synthesizer | None = None,
        variant: str = "fp32",
    ) -> None:
        self.model_dir, self.voice, self.speed, self.variant = model_dir, voice, speed, variant
        self.lexicon = lexicon if lexicon is not None else Lexicon.load()
        self._synth = synthesizer
        self.rendered = self.reused = 0

    @property
    def model_name(self) -> str:
        return self._synth.name if self._synth else f"kokoro-v1.0-{self.variant}/en-gb"

    @property
    def synthesizer(self) -> Synthesizer:
        if self._synth is None:  # loaded only when a clip actually needs rendering
            self._synth = KokoroSynthesizer(self.model_dir, self.variant)
        return self._synth

    def clip_hash(self, text: str) -> str:
        spoken, used = self.lexicon.apply(_tidy(text))
        return key_for(
            "voice", RENDER_VERSION, spoken, used, self.voice, self.model_name, self.speed
        )[:20]

    def path_for(self, text: str, out_dir: Path) -> Path:
        return out_dir / f"{self.clip_hash(text)}.mp3"

    def render(self, text: str, out_dir: Path) -> Path:
        """`out_dir/<hash>.mp3`, synthesized only if it doesn't exist yet."""
        path = self.path_for(text, out_dir)
        if path.exists():
            self.reused += 1
            return path
        spoken, _ = self.lexicon.apply(_tidy(text))
        synth = self.synthesizer
        audio = synth.synthesize(spoken, self.voice, self.speed)
        data = encode_mp3(normalise(audio, synth.sample_rate), synth.sample_rate)
        out_dir.mkdir(parents=True, exist_ok=True)
        partial = path.with_suffix(f".{os.getpid()}.part")
        partial.write_bytes(data)
        partial.replace(path)
        self.rendered += 1
        return path


def _tidy(text: str) -> str:
    return " ".join(text.split())


# --- giggle-voice-samples --------------------------------------------------------

SAMPLES = [
    "You're listening to Glass Harbour, a Glasgow four-piece who pour shoegaze guitars over "
    "a post-punk rhythm section. They play the Tolhuistuin on Thursday the sixteenth of "
    "October, and tickets are about 24 euros.",
    "Before that, Mira Sol: born in Lisbon, based in Amsterdam, and somewhere between jazz "
    "and fado. Catch her at the Bimhuis, or a week later at the Muziekgebouw aan 't IJ.",
    "That was Paradiso's favourite noise band of the year. They're back at the Melkweg in "
    "November, then on to OCCII, TivoliVredenburg, Patronaat, Nobel, Cinetol and Bitterzoet.",
]
SAMPLE_VOICES = ("bf_emma", "bf_isabella", "bf_alice", "bf_lily", "bm_george", "bm_fable",
                 "bm_lewis", "bm_daniel")  # fmt: skip


def samples_page(rows: Sequence[dict[str, Any]], texts: Sequence[str], model: str) -> str:
    items = "\n".join(
        f'<li><h2>{html.escape(r["voice"])}</h2><audio controls preload="none" '
        f'src="{html.escape(r["file"])}"></audio>'
        f"<p>{r['seconds']:.1f} s of audio, "
        + (f"rendered in {r['render']:.1f} s" if r["render"] is not None else "from cache")
        + "</p></li>"
        for r in rows
    )
    quoted = "\n".join(f"<blockquote>{html.escape(t)}</blockquote>" for t in texts)
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>giggle voices</title>
<style>
 :root {{ color-scheme: light dark; font-family: system-ui, sans-serif; }}
 body {{ max-width: 44rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }}
 ul {{ list-style: none; padding: 0; }} li {{ margin: 0 0 1.25rem; }}
 h2 {{ font-size: 1rem; margin: 0 0 .25rem; font-family: ui-monospace, monospace; }}
 audio {{ width: 100%; }} p {{ margin: .25rem 0; opacity: .7; font-size: .9rem; }}
 blockquote {{ margin: .5rem 0; padding-left: .75rem; border-left: 3px solid #8884; }}
</style></head><body>
<h1>Announcer voices</h1>
<p>Kokoro-82M ({html.escape(model)}), British English. Each clip reads:</p>
{quoted}
<ul>
{items}
</ul>
</body></html>
"""


def samples_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="giggle-voice-samples",
        description="Render the same sample announcements in several voices, to choose by ear.",
    )
    parser.add_argument("--voices", nargs="*", default=list(SAMPLE_VOICES))
    parser.add_argument("--out", type=Path, default=Path("data/voice-samples"))
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument("--variant", choices=list(MODELS), default="fp32")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--phonemes", metavar="TEXT", help="print the phonemes for TEXT and stop")
    args = parser.parse_args(argv)

    lexicon = Lexicon.load()
    try:
        synth = KokoroSynthesizer(args.model_dir, args.variant)
    except VoiceError as exc:
        print(f"giggle-voice-samples: {exc}", file=sys.stderr)
        return 1
    if args.phonemes:
        spoken, used = lexicon.apply(args.phonemes)
        print(synth.phonemes(spoken))
        for written, ipa in used.items():
            print(f"  lexicon: {written} → /{ipa}/", file=sys.stderr)
        return 0

    unknown = sorted(set(args.voices) - set(synth.voices()))
    if unknown:
        print(f"giggle-voice-samples: unknown voices {', '.join(unknown)}", file=sys.stderr)
        return 1
    text = " ".join(SAMPLES)
    rows = []
    for name in args.voices:
        voice = Voice(args.model_dir, name, args.speed, lexicon, synth, args.variant)
        started = time.perf_counter()
        clip = voice.render(text, args.out / "clips")
        took = time.perf_counter() - started
        shutil.copyfile(clip, args.out / f"{name}.mp3")
        seconds = mp3_seconds(clip)
        status = "rendered" if voice.rendered else "cached"
        print(f"{name}: {status} {seconds:.1f} s of audio in {took:.1f} s", file=sys.stderr)
        render = took if voice.rendered else None
        rows.append({"voice": name, "file": f"{name}.mp3", "seconds": seconds, "render": render})
    page = args.out / "index.html"
    page.write_text(samples_page(rows, SAMPLES, synth.name))
    print(page.resolve())
    return 0


def mp3_seconds(path: Path) -> float:
    """How long a clip plays for, from its size: `encode_mp3` writes constant-bitrate
    frames (144 bytes = 576 samples at 48 kbps, 24 kHz) and no tags. That includes the
    100 ms pads and the encoder's ~50 ms of lead-in, which players don't trim without a
    LAME tag, so it's the length a browser reports."""
    return path.stat().st_size * 8 / (BITRATE_KBPS * 1000)


if __name__ == "__main__":
    sys.exit(samples_main())
