// Messages between the page and kokoro.worker.ts. Kept apart from the worker so importing
// the types doesn't pull the model library into the page's bundle.

export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export type Device = 'webgpu' | 'wasm';
export type Dtype = 'fp32' | 'fp16' | 'q8' | 'q4';

export type KokoroRequest =
	| { type: 'load'; device: Device | 'auto'; dtype: Dtype | 'auto' }
	| { type: 'lexicon'; data: unknown }
	| { type: 'say'; id: number; text: string; voice: string; speed: number };

export type KokoroReply =
	| { type: 'progress'; file: string; loaded: number; total: number }
	| { type: 'ready'; device: Device; dtype: Dtype; ms: number }
	| { type: 'failed'; message: string }
	| {
			type: 'audio';
			id: number;
			samples: Float32Array;
			sampleRate: number;
			/** Synthesis time, phonemes included. */
			ms: number;
			/** Of which: text → phonemes (espeak). */
			phonemeMs: number;
			phonemes: string;
	  }
	| { type: 'error'; id: number; message: string };
