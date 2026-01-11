const normalizeDigits = (value) => value.replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xFF10));

const pluralize = (value, singular, plural) => (value === 1 ? singular : plural);

const normalizeTimeInput = (value) => {
    if (typeof value !== 'string') {
        return value;
    }
    const trimmed = value.trim();
    const patterns = [
        { regex: /^([0-9０-９]+)\s*分\s*後$/, unit: { singular: 'minute', plural: 'minutes' } },
        { regex: /^([0-9０-９]+)\s*時間\s*後$/, unit: { singular: 'hour', plural: 'hours' } },
        { regex: /^([0-9０-９]+)\s*日\s*後$/, unit: { singular: 'day', plural: 'days' } },
    ];

    for (const pattern of patterns) {
        const match = trimmed.match(pattern.regex);
        if (!match) {
            continue;
        }
        const amount = Number(normalizeDigits(match[1]));
        if (!Number.isFinite(amount)) {
            return value;
        }
        const unit = pluralize(amount, pattern.unit.singular, pattern.unit.plural);
        return `in ${amount} ${unit}`;
    }

    return value;
};

module.exports = {
    normalizeDigits,
    normalizeTimeInput,
};
