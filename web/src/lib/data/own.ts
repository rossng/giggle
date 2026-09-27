// Looking up keys that come from data or the URL. A plain object answers "constructor",
// "toString" or "__proto__" from Object.prototype, so `venues[slug]` or `ALIASES[genre]` could
// hand back a function where a venue or a string was expected, and a page (or the whole catalog)
// would throw. A MusicBrainz tag, a venue's genre or a typed URL is enough.

/** `record[key]`, if `key` is the record's own property. */
export function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** A copy of `record` without a prototype, so any key can index it safely. */
export function dict<T>(record: Readonly<Record<string, T>>): Record<string, T> {
	return Object.assign(Object.create(null) as Record<string, T>, record);
}
