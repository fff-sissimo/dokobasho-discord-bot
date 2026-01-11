const { addDays, addMonths, addWeeks, isValid } = require('date-fns');

/**
 * Calculates the next occurrence of a recurring reminder.
 * @param {string} isoDate - The last notification time.
 * @param {'daily' | 'weekly' | 'monthly'} recurringType - The recurrence type.
 * @returns {string|null} - The next notification time as an ISO string, or null.
 */
function calculateNextDate(isoDate, recurringType) {
    const date = new Date(isoDate);
    if (!isValid(date)) {
        return null;
    }

    switch (recurringType) {
        case 'daily':
            return addDays(date, 1).toISOString();
        case 'weekly':
            return addWeeks(date, 1).toISOString();
        case 'monthly':
            return addMonths(date, 1).toISOString();
        default:
            return null;
    }
}

module.exports = {
    calculateNextDate,
};
