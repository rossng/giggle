// Messages between the page and kokoro.worker.ts. Kept apart from the worker so importing
// the types doesn't pull the model library into the page's bundle.

import { MODEL_FILES } from './model-source';

export type Device = 'webgpu' | 'wasm';
/** The precisions we serve (model-files.json): fp32 (WebGPU) and q8 (WASM). Others (fp16, q4,
 * …) exist on Hugging Face; to offer one, add its file to model-files.json and upload it. */
export type Dtype = keyof typeof MODEL_FILES.dtypes;
export const DTYPES = Object.keys(MODEL_FILES.dtypes) as Dtype[];

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
