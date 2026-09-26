import { describe, expect, it } from 'vitest';
import {
	addDays,
	amsterdamDate,
	dayParts,
	daysBetween,
	formatRange,
	localDate,
	localTime,
	relativeDays,
	weekLabel,
	weekStart
} from './dates';

describe('dates', () => {
	it("reads today's date in Amsterdam", () => {
		expect(amsterdamDate(new Date('2026-09-26T21:59:00Z'))).toBe('2026-09-26');
		expect(amsterdamDate(new Date('2026-09-26T22:00:00Z'))).toBe('2026-09-27');
		expect(amsterdamDate(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
	});

	it('takes local dates and times from gig times', () => {
		expect(localDate('2026-10-25T01:30:00+01:00')).toBe('2026-10-25');
		expect(localTime('2026-10-03T20:30:00+02:00')).toBe('20:30');
	});

	it('adds days across DST and year ends', () => {
		expect(addDays('2026-10-24', 2)).toBe('2026-10-26');
		expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
		expect(daysBetween('2026-09-26', '2026-12-25')).toBe(90);
	});

	it('finds Mondays and names weeks', () => {
		expect(weekStart('2026-09-26')).toBe('2026-09-21'); // a Saturday
		expect(weekStart('2026-09-21')).toBe('2026-09-21');
		expect(weekLabel('2026-09-21', '2026-09-26')).toBe('This week');
		expect(weekLabel('2026-09-28', '2026-09-26')).toBe('Next week');
		expect(weekLabel('2026-10-12', '2026-09-26')).toBe('Week of 12 Oct');
		expect(weekLabel('2027-01-04', '2026-09-26')).toBe('Week of 4 Jan 2027');
	});

	it('formats days and ranges', () => {
		expect(dayParts('2026-10-03')).toEqual({ weekday: 'Sat', day: 3, month: 'Oct', year: 2026 });
		expect(formatRange('2026-09-29', '2026-12-26')).toBe('29 Sep – 26 Dec 2026');
		expect(formatRange('2026-12-01', '2027-01-15')).toBe('1 Dec 2026 – 15 Jan 2027');
		expect(relativeDays('2026-09-27', '2026-09-26')).toBe('tomorrow');
		expect(relativeDays('2026-10-16', '2026-09-26')).toBe('in 3 wks');
	});
});
