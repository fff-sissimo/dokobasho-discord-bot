const { calculateNextDate } = require('../src/utils');

describe('calculateNextDate', () => {
    it('should correctly calculate the next daily date', () => {
        const d = new Date('2026-01-10T12:00:00.000Z');
        const next = calculateNextDate(d.toISOString(), 'daily');
        expect(next).toBe('2026-01-11T12:00:00.000Z');
    });

    it('should correctly calculate the next weekly date', () => {
        const d = new Date('2026-01-10T12:00:00.000Z');
        const next = calculateNextDate(d.toISOString(), 'weekly');
        expect(next).toBe('2026-01-17T12:00:00.000Z');
    });

    it('should correctly calculate the next monthly date on a simple case', () => {
        const d = new Date('2026-03-15T12:00:00.000Z');
        const next = calculateNextDate(d.toISOString(), 'monthly');
        expect(next).toBe('2026-04-15T12:00:00.000Z');
    });

    it('should clamp end-of-month dates to the last day of the next month', () => {
        const d = new Date('2026-01-31T12:00:00.000Z');
        const next = calculateNextDate(d.toISOString(), 'monthly');
        expect(next).toBe('2026-02-28T12:00:00.000Z');
    });

    it('should handle leap year end-of-month dates', () => {
        const d = new Date('2024-01-31T12:00:00.000Z');
        const next = calculateNextDate(d.toISOString(), 'monthly');
        expect(next).toBe('2024-02-29T12:00:00.000Z');
    });

    it('should carry the clamped day forward on subsequent months', () => {
        const d = new Date('2026-02-28T12:00:00.000Z');
        const next = calculateNextDate(d.toISOString(), 'monthly');
        expect(next).toBe('2026-03-28T12:00:00.000Z');
    });
    
    it('should return null for invalid date input', () => {
        const next = calculateNextDate('not a date', 'daily');
        expect(next).toBeNull();
    });

    it('should return null for invalid recurring type', () => {
        const d = new Date('2026-01-10T12:00:00.000Z');
        const next = calculateNextDate(d.toISOString(), 'yearly'); // 'yearly' is not a valid type
        expect(next).toBeNull();
    });
});
