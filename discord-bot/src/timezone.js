const DEFAULT_TIMEZONE = 'Asia/Tokyo';
const TIMEZONE_ABBR_OFFSETS = {
    JST: 540,
    UTC: 0,
    GMT: 0,
};

function parseTimezoneOffset(input) {
    if (!input) {
        return null;
    }
    const match = input.match(/^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/i);
    if (!match) {
        return null;
    }
    const sign = match[1] === '-' ? -1 : 1;
    const hours = Number(match[2]);
    const minutes = Number(match[3] || '0');
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours > 14 || minutes > 59) {
        return null;
    }
    return sign * (hours * 60 + minutes);
}

function getTimezoneOffsetMinutes(timeZone, date) {
    try {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });
        const parts = formatter.formatToParts(date);
        const values = {};
        for (const part of parts) {
            if (part.type !== 'literal') {
                values[part.type] = part.value;
            }
        }
        if (!values.year || !values.month || !values.day || !values.hour || !values.minute || !values.second) {
            return null;
        }
        const utcTimestamp = Date.UTC(
            Number(values.year),
            Number(values.month) - 1,
            Number(values.day),
            Number(values.hour),
            Number(values.minute),
            Number(values.second)
        );
        return Math.round((utcTimestamp - date.getTime()) / 60000);
    } catch (error) {
        return null;
    }
}

function resolveTimezone(timezoneInput, referenceInstant = new Date()) {
    const raw = typeof timezoneInput === 'string' ? timezoneInput.trim() : '';
    const fallback = raw || process.env.DEFAULT_TZ || DEFAULT_TIMEZONE;
    const abbr = fallback.toUpperCase();
    let offset = parseTimezoneOffset(fallback);
    let source = 'offset';
    let label = fallback;

    if (offset === null && TIMEZONE_ABBR_OFFSETS[abbr] !== undefined) {
        offset = TIMEZONE_ABBR_OFFSETS[abbr];
        source = 'abbr';
        label = abbr;
    }
    if (offset === null) {
        offset = getTimezoneOffsetMinutes(fallback, referenceInstant);
        if (offset !== null) {
            source = 'iana';
        }
    }
    if (offset === null) {
        return { error: '❌ タイムゾーンの指定が正しくありません。例: Asia/Tokyo / JST / +09:00' };
    }

    return { label, offset, source };
}

function adjustDateForTimezone(parsedDate, timezoneLabel, referenceOffsetMinutes) {
    const targetOffset = getTimezoneOffsetMinutes(timezoneLabel, parsedDate);
    if (targetOffset === null || targetOffset === referenceOffsetMinutes) {
        return parsedDate;
    }
    // chrono uses the reference offset; adjust when the target date crosses a DST boundary.
    return new Date(parsedDate.getTime() + (referenceOffsetMinutes - targetOffset) * 60000);
}

module.exports = {
    DEFAULT_TIMEZONE,
    parseTimezoneOffset,
    getTimezoneOffsetMinutes,
    resolveTimezone,
    adjustDateForTimezone,
};
