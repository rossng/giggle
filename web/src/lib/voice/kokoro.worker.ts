// Kokoro-82M in a Web Worker (kokoro-js / transformers.js), so synthesis never blocks the
// page or the YouTube player. The model and voices download from our own origin
// (model-source.ts) on first use and stay in the browser's cache. Protocol: see KokoroRequest /
// KokoroReply.

import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { phonemize } from 'phonemizer';
import { normalise } from './audio';
import { Lexicon } from './lexicon';
import {
	MODEL_FILES,
	MODEL_ID,
	MODEL_PATH,
	modelFetch,
	pruneStaleModelFiles
} from './model-source';
import { toPhonemes } from './phonemes';
import type { Device, Dtype, KokoroReply, KokoroRequest } from './protocol';

// transformers.js builds `${remoteHost}${remotePathTemplate}${file}`; kokoro-js never passes a
// revision, so the pinned one is part of the template (and of the URL, which is what lets the
// Worker cache the files forever). vite.config.ts dedupes the package, so this is kokoro-js's
// copy of `env`.
const MODEL_BASE = new URL(MODEL_PATH, self.location.origin).href;
env.allowLocalModels = false;
env.remoteHost = new URL('/models/', self.location.origin).href;
env.remotePathTemplate = `${MODEL_FILES.name}/${MODEL_FILES.revision}/`;
// transformers.js points ONNX Runtime at its wasm on cdn.jsdelivr.net; without that, ORT uses
// the copy Vite bundles (`new URL(…wasm, import.meta.url)`), served from our origin.
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = undefined;
globalThis.fetch = modelFetch(globalThis.fetch.bind(globalThis), {
	base: MODEL_BASE,
	devFallback: import.meta.env.DEV
});

let tts: KokoroTTS | null = null;
let lexicon: Lexicon | null = null;
// One synthesis at a time: the model isn't re-entrant, and queued lines keep their order.
let queue: Promise<unknown> = Promise.resolve();

const post = (reply: KokoroReply, transfer: Transferable[] = []) =>
	(self as unknown as Worker).postMessage(reply, transfer);

async function hasWebGPU(): Promise<boolean> {
	const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
	try {
		return !!(gpu && (await gpu.requestAdapter()));
	} catch {
		return false;
	}
}

async function load(device: Device | 'auto', dtype: Dtype | 'auto'): Promise<void> {
	const started = performance.now();
	const dev: Device = device === 'auto' ? ((await hasWebGPU()) ? 'webgpu' : 'wasm') : device;
	// kokoro-js recommends fp32 on WebGPU; q8 is the small, fast choice on the CPU.
	const dt: Dtype = dtype === 'auto' ? (dev === 'webgpu' ? 'fp32' : 'q8') : dtype;
	tts = await KokoroTTS.from_pretrained(MODEL_ID, {
		device: dev,
		dtype: dt,
		progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
			if (p.status === 'progress' && p.file)
				post({ type: 'progress', file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0 });
		}
	});
	post({ type: 'ready', device: dev, dtype: dt, ms: performance.now() - started });
	void pruneStaleModelFiles(MODEL_BASE);
}

async function say(id: number, text: string, voice: string, speed: number): Promise<void> {
	if (!tts) throw new Error('model not loaded');
	const started = performance.now();
	const phonemes = await toPhonemes(text, lexicon, phonemize);
	const phonemeMs = performance.now() - started;
	const { input_ids } = tts.tokenizer(phonemes, { truncation: true });
	const audio = await tts.generate_from_ids(input_ids, {
		voice: voice as keyof KokoroTTS['voices'],
		speed
	});
	const samples = normalise(audio.audio as Float32Array, audio.sampling_rate);
	const ms = performance.now() - started;
	post({ type: 'audio', id, samples, sampleRate: audio.sampling_rate, ms, phonemeMs, phonemes }, [
		samples.buffer
	]);
}

self.onmessage = (event: MessageEvent<KokoroRequest>) => {
	const msg = event.data;
	if (msg.type === 'lexicon') {
		lexicon = Lexicon.parse(msg.data);
	} else if (msg.type === 'load') {
		queue = queue
			.then(() => load(msg.device, msg.dtype))
			.catch((e: unknown) => post({ type: 'failed', message: String(e) }));
	} else if (msg.type === 'say') {
		queue = queue
			.then(() => say(msg.id, msg.text, msg.voice, msg.speed))
			.catch((e: unknown) => post({ type: 'error', id: msg.id, message: String(e) }));
	}
};
