import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAGE_PATHS } from './pages';

const ROUTES = join(import.meta.dirname, '..', 'routes');

/** Each page route's pattern: "(app)/artists/[slug]" → /^\/artists\/[^/]+$/. */
function pageRoutes(): RegExp[] {
	const dirs = new Set<string>();
	for (const entry of readdirSync(ROUTES, { recursive: true, withFileTypes: true })) {
		if (entry.isFile() && /^\+page\.(svelte|ts|js)$/.test(entry.name)) {
			dirs.add(relative(ROUTES, entry.parentPath));
		}
	}
	return [...dirs].map((dir) => {
		const parts = dir
			.split(sep)
			.filter((part) => part && !/^\(.*\)$/.test(part))
			.map((part) => (/^\[.*\]$/.test(part) ? '[^/]+' : part));
		return new RegExp(`^/${parts.join('/')}$`);
	});
}

describe('PAGE_PATHS', () => {
	it('has one path for every page route', () => {
		const routes = pageRoutes();
		expect(routes.length).toBe(PAGE_PATHS.length);
		for (const route of routes) {
			expect(
				PAGE_PATHS.filter((path) => route.test(path)),
				String(route)
			).toHaveLength(1);
		}
	});
});
