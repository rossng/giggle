import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha256 } from './sha256';

const reference = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

function bytes(n: number, seed = 1): Uint8Array {
	const out = new Uint8Array(n);
	let x = seed;
	for (let i = 0; i < n; i++) {
		x = (x * 1103515245 + 12345) >>> 0;
		out[i] = x >>> 24;
	}
	return out;
}

describe('Sha256', () => {
	it('matches the known digests', () => {
		expect(new Sha256().hex()).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		);
		expect(new Sha256().update(new TextEncoder().encode('abc')).hex()).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});

	it('matches node:crypto around the block and padding boundaries', () => {
		for (const n of [1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4097]) {
			const data = bytes(n, n);
			expect(new Sha256().update(data).hex()).toBe(reference(data));
		}
	});

	it('gives the same digest however the input is chunked', () => {
		const data = bytes(10_000);
		for (const size of [1, 3, 63, 64, 65, 1500]) {
			const hash = new Sha256();
			for (let i = 0; i < data.length; i += size) hash.update(data.subarray(i, i + size));
			expect(hash.hex()).toBe(reference(data));
		}
	});
});
