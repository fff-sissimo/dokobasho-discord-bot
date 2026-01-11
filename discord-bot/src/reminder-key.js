const crypto = require('crypto');

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KEY_LENGTH = 8;

function generateReminderKey() {
    const bytes = crypto.randomBytes(KEY_LENGTH);
    let key = '';
    for (let i = 0; i < KEY_LENGTH; i += 1) {
        key += KEY_ALPHABET[bytes[i] & 31];
    }
    return key;
}

module.exports = {
    generateReminderKey,
    KEY_ALPHABET,
    KEY_LENGTH,
};
