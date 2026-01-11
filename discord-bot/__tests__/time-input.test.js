const { normalizeDigits, normalizeTimeInput } = require('../src/time-input');

describe('time input normalization', () => {
    it('normalizes full-width digits', () => {
        expect(normalizeDigits('１２３')).toBe('123');
    });

    it('converts "10分後" to English minutes', () => {
        expect(normalizeTimeInput('10分後')).toBe('in 10 minutes');
    });

    it('converts full-width digits in "１０分後"', () => {
        expect(normalizeTimeInput('１０分後')).toBe('in 10 minutes');
    });

    it('handles surrounding whitespace', () => {
        expect(normalizeTimeInput('  10 分 後  ')).toBe('in 10 minutes');
    });

    it('converts "1時間後" to English hours', () => {
        expect(normalizeTimeInput('1時間後')).toBe('in 1 hour');
    });

    it('converts "２日後" to English days', () => {
        expect(normalizeTimeInput('２日後')).toBe('in 2 days');
    });

    it('returns input when format does not match', () => {
        expect(normalizeTimeInput('10分')).toBe('10分');
        expect(normalizeTimeInput('十分後')).toBe('十分後');
        expect(normalizeTimeInput('10分後に')).toBe('10分後に');
    });
});
