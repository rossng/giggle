// Live Kokoro audio processed like the pipeline's clips (voice.py `normalise`), so a clip
// and the live line after it sound equally loud.

export const TARGET_RMS_DBFS = -18;
export const PEAK_CEILING_DBFS = -1;

/** Speech brought to a steady level (RMS over voiced 20 ms frames, pauses ignored), peaks
 * kept under the ceiling, ends faded so there's no click. Returns a new array. */
export function normalise(audio: Float32Array, sampleRate: number): Float32Array {
	const out = new Float32Array(audio);
	let peak = 0;
	for (const x of out) peak = Math.max(peak, Math.abs(x));
	if (!out.length || peak === 0) return out;
	const frame = Math.max(1, Math.floor(sampleRate / 50));
	const frames = Math.max(1, Math.floor(out.length / frame));
	const size = out.length >= frame ? frame : out.length;
	const rms: number[] = [];
	for (let f = 0; f < frames; f++) {
		let sum = 0;
		for (let i = f * size; i < (f + 1) * size; i++) sum += out[i]! ** 2;
		rms.push(Math.sqrt(sum / size));
	}
	const floor = Math.max(...rms) * 10 ** (-30 / 20); // within 30 dB of the loudest frame
	const voiced = rms.filter((r) => r >= floor);
	const level = Math.sqrt(voiced.reduce((a, r) => a + r * r, 0) / voiced.length);
	const gain = Math.min(
		10 ** (TARGET_RMS_DBFS / 20) / level,
		10 ** (PEAK_CEILING_DBFS / 20) / peak
	);
	for (let i = 0; i < out.length; i++) out[i]! *= gain;
	const fade = Math.min(Math.floor(out.length / 2), Math.floor(sampleRate / 200));
	for (let i = 0; i < fade; i++) {
		const ramp = fade > 1 ? i / (fade - 1) : 0;
		out[i]! *= ramp;
		out[out.length - 1 - i]! *= ramp;
	}
	return out;
}
