const crypto = require('crypto');
const { generateReminderKey, KEY_ALPHABET, KEY_LENGTH } = require('../src/reminder-key');

describe('reminder key generator', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('generates keys with the expected length and alphabet', () => {
        const key = generateReminderKey();
        const pattern = new RegExp(`^[${KEY_ALPHABET}]{${KEY_LENGTH}}$`);
        expect(key).toMatch(pattern);
    });

    it('generates different keys across multiple calls', () => {
        const keys = new Set();
        for (let i = 0; i < 20; i += 1) {
            keys.add(generateReminderKey());
        }
        expect(keys.size).toBeGreaterThan(1);
    });

    it('maps random bytes to the alphabet using the lower 5 bits', () => {
        const bytes = Buffer.from([255, 254, 253, 252, 251, 250, 249, 248]);
        jest.spyOn(crypto, 'randomBytes').mockReturnValue(bytes);
        const key = generateReminderKey();
        const expected = bytes
            .slice(0, KEY_LENGTH)
            .map((value) => KEY_ALPHABET[value & 31])
            .join('');
        expect(key).toBe(expected);
    });
});
