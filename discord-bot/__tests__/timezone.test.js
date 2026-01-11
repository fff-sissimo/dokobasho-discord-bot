const {
    resolveTimezone,
    parseTimezoneOffset,
    adjustDateForTimezone,
} = require('../src/timezone');

const supportsIanaTimeZone = (timeZone) => {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone }).format();
        return true;
    } catch (error) {
        return false;
    }
};

describe('timezone helpers', () => {
    it('parses explicit UTC offsets', () => {
        expect(parseTimezoneOffset('+09:00')).toBe(540);
        expect(parseTimezoneOffset('-0530')).toBe(-330);
        expect(parseTimezoneOffset('UTC+9')).toBe(540);
        expect(parseTimezoneOffset('GMT-2')).toBe(-120);
        expect(parseTimezoneOffset('+05')).toBe(300);
        expect(parseTimezoneOffset('UTC-12')).toBe(-720);
        expect(parseTimezoneOffset('+14:00')).toBe(840);
        expect(parseTimezoneOffset('+15:00')).toBeNull();
        expect(parseTimezoneOffset('bad')).toBeNull();
    });

    it('resolves abbreviations and offsets', () => {
        const referenceInstant = new Date('2026-01-10T00:00:00.000Z');
        const abbr = resolveTimezone('JST', referenceInstant);
        expect(abbr).toMatchObject({ label: 'JST', offset: 540, source: 'abbr' });

        const utc = resolveTimezone('UTC', referenceInstant);
        expect(utc).toMatchObject({ label: 'UTC', offset: 0, source: 'abbr' });

        const gmt = resolveTimezone('GMT', referenceInstant);
        expect(gmt).toMatchObject({ label: 'GMT', offset: 0, source: 'abbr' });

        const offset = resolveTimezone('+09:00', referenceInstant);
        expect(offset).toMatchObject({ label: '+09:00', offset: 540, source: 'offset' });
    });

    it('uses DEFAULT_TZ when timezone is omitted', () => {
        const original = process.env.DEFAULT_TZ;
        process.env.DEFAULT_TZ = 'UTC';
        const result = resolveTimezone('', new Date('2026-01-10T00:00:00.000Z'));
        expect(result).toMatchObject({ label: 'UTC', offset: 0, source: 'abbr' });
        if (original === undefined) {
            delete process.env.DEFAULT_TZ;
        } else {
            process.env.DEFAULT_TZ = original;
        }
    });

    it('returns an error for invalid timezones', () => {
        const result = resolveTimezone('Invalid/Zone', new Date('2026-01-10T00:00:00.000Z'));
        expect(result.error).toBeDefined();
    });
});

describe('timezone helpers with IANA zones', () => {
    it('resolves Asia/Tokyo offsets', () => {
        if (!supportsIanaTimeZone('Asia/Tokyo')) {
            throw new Error('IANA time zone support is required for timezone tests.');
        }
        const referenceInstant = new Date('2026-01-10T00:00:00.000Z');
        const result = resolveTimezone('Asia/Tokyo', referenceInstant);
        expect(result).toMatchObject({ label: 'Asia/Tokyo', offset: 540, source: 'iana' });
    });
});

describe('timezone helpers with DST', () => {
    it('adjusts when the target date crosses a DST boundary', () => {
        if (!supportsIanaTimeZone('America/New_York')) {
            throw new Error('IANA time zone support is required for DST tests.');
        }
        const referenceInstant = new Date('2026-01-10T00:00:00.000Z');
        const resolved = resolveTimezone('America/New_York', referenceInstant);
        expect(resolved.source).toBe('iana');

        const parsedDate = new Date('2026-07-01T15:00:00.000Z');
        const adjusted = adjustDateForTimezone(parsedDate, resolved.label, resolved.offset);
        expect(adjusted.toISOString()).toBe('2026-07-01T14:00:00.000Z');
    });
});
