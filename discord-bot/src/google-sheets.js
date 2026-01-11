const fs = require('fs');
const logger = require('./logger');
require('dotenv').config();
const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

const { GOOGLE_SA_KEY_JSON, GOOGLE_SA_KEY_PATH, SHEET_ID } = process.env;

if ((!GOOGLE_SA_KEY_JSON && !GOOGLE_SA_KEY_PATH) || !SHEET_ID) {
    logger.warn('WARNING: GOOGLE_SA_KEY_JSON/GOOGLE_SA_KEY_PATH or SHEET_ID is not set. Google Sheets integration will be disabled.');
}

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const SHEET_NAME = 'Reminders';
const MAX_REMINDER_ROWS = Number.parseInt(process.env.REMINDER_MAX_ROWS || '5000', 10);
const SENDING_TIMEOUT_MS = Number.parseInt(process.env.REMINDER_SENDING_TIMEOUT_MS || '300000', 10);

// As defined in doc/reminder/03_database_schema.md
const SCHEMA = [
    'id', 'key', 'content', 'scope', 'guild_id', 'channel_id', 'user_id',
    'notify_time_utc', 'timezone', 'recurring', 'visibility', 'created_by',
    'created_at', 'status', 'last_sent', 'retry_count', 'metadata'
];

let sheets;
let didWarnLargeSheet = false;

/**
 * Initializes and returns a Google Sheets API client.
 * Caches the client for subsequent calls.
 * @returns {Promise<import('googleapis').sheets_v4.Sheets>}
 */
async function getSheetsClient() {
    if (sheets) {
        return sheets;
    }

    if (!GOOGLE_SA_KEY_JSON && !GOOGLE_SA_KEY_PATH) {
        throw new Error('Google Service Account key (GOOGLE_SA_KEY_JSON/GOOGLE_SA_KEY_PATH) is not configured in .env file.');
    }

    try {
        const keyFileContent = GOOGLE_SA_KEY_PATH
            ? fs.readFileSync(GOOGLE_SA_KEY_PATH, 'utf-8')
            : Buffer.from(GOOGLE_SA_KEY_JSON, 'base64').toString('utf-8');
        const keys = JSON.parse(keyFileContent);

        const auth = new JWT({
            email: keys.client_email,
            key: keys.private_key,
            scopes: SCOPES,
        });

        const client = await auth.getClient();
        sheets = google.sheets({ version: 'v4', auth: client });
        logger.info('Google Sheets client initialized successfully.');
        return sheets;
    } catch (error) {
        logger.error('Failed to initialize Google Sheets client:', error);
        throw error;
    }
}

function buildHeaderMap(header) {
    const map = {};
    header.forEach((name, index) => {
        if (name) {
            map[name] = index;
        }
    });
    return map;
}

async function getHeaderData(client) {
    const res = await client.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!1:1`,
    });

    const header = res.data.values && res.data.values[0];
    if (!header || header.length === 0) {
        throw new Error('Sheet header row is missing.');
    }

    return { header, headerMap: buildHeaderMap(header) };
}

function columnIndexToLetter(index) {
    let temp = index + 1;
    let letter = '';
    while (temp > 0) {
        const remainder = (temp - 1) % 26;
        letter = String.fromCharCode(65 + remainder) + letter;
        temp = Math.floor((temp - 1) / 26);
    }
    return letter;
}

function getColumnRange(headerMap, columns) {
    const indices = columns.map(name => {
        const index = headerMap[name];
        if (index === undefined) {
            throw new Error(`Sheet missing "${name}" column.`);
        }
        return index;
    });

    const startIndex = Math.min(...indices);
    const endIndex = Math.max(...indices);

    return {
        startIndex,
        endIndex,
        startCol: columnIndexToLetter(startIndex),
        endCol: columnIndexToLetter(endIndex),
    };
}

function mapRowToObject(row, headerSlice) {
    const reminder = {};
    headerSlice.forEach((colName, index) => {
        reminder[colName] = row[index] ?? '';
    });
    return reminder;
}

async function fetchRowsByColumns(client, header, headerMap, columns) {
    const { startIndex, endIndex, startCol, endCol } = getColumnRange(headerMap, columns);
    const res = await client.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!${startCol}2:${endCol}`,
    });

    const rows = res.data.values || [];
    if (MAX_REMINDER_ROWS > 0 && rows.length > MAX_REMINDER_ROWS) {
        if (!didWarnLargeSheet) {
            logger.warn({ rowCount: rows.length, maxRows: MAX_REMINDER_ROWS }, 'Reminders sheet exceeds configured row limit.');
            didWarnLargeSheet = true;
        }
        throw new Error(`Reminders sheet exceeds REMINDER_MAX_ROWS (${MAX_REMINDER_ROWS}).`);
    }
    const headerSlice = header.slice(startIndex, endIndex + 1);
    return { rows, headerSlice };
}

async function fetchRowByIndex(client, header, headerMap, rowIndex, columns) {
    const { startIndex, endIndex, startCol, endCol } = getColumnRange(headerMap, columns);
    const res = await client.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!${startCol}${rowIndex}:${endCol}${rowIndex}`,
    });

    const row = (res.data.values && res.data.values[0]) || [];
    const headerSlice = header.slice(startIndex, endIndex + 1);
    return mapRowToObject(row, headerSlice);
}

async function findRowIndexById(client, header, headerMap, reminderId, { includeDeleted = false } = {}) {
    const { rows, headerSlice } = await fetchRowsByColumns(client, header, headerMap, ['id', 'status']);
    const idIndex = headerSlice.indexOf('id');
    const statusIndex = headerSlice.indexOf('status');

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowId = row[idIndex];
        if (rowId !== reminderId) {
            continue;
        }
        const status = statusIndex === -1 ? '' : row[statusIndex];
        if (!includeDeleted && status === 'deleted') {
            return null;
        }
        return { rowIndex: i + 2, status: status || '' };
    }

    return null;
}

async function updateColumnsByRowIndex(client, headerMap, rowIndex, updates) {
    const data = [];
    Object.entries(updates).forEach(([key, value]) => {
        if (key === 'id' || value === undefined) {
            return;
        }
        const colIndex = headerMap[key];
        if (colIndex === undefined) {
            throw new Error(`Sheet missing "${key}" column.`);
        }
        const colLetter = columnIndexToLetter(colIndex);
        data.push({
            range: `${SHEET_NAME}!${colLetter}${rowIndex}:${colLetter}${rowIndex}`,
            values: [[value]],
        });
    });

    if (data.length === 0) {
        return null;
    }

    const res = await client.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        valueInputOption: 'USER_ENTERED',
        resource: { data },
    });

    return res.data;
}

/**
 * Finds a reminder by its key and scope.
 * @param {string} key
 * @param {string} scope
 * @returns {Promise<object|null>}
 */
async function getReminderByKey(key, scope) {
    const client = await getSheetsClient();
    const { header, headerMap } = await getHeaderData(client);
    const { rows, headerSlice } = await fetchRowsByColumns(client, header, headerMap, ['id', 'key', 'scope', 'status']);

    const keyIndex = headerSlice.indexOf('key');
    const scopeIndex = headerSlice.indexOf('scope');
    const statusIndex = headerSlice.indexOf('status');

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const status = statusIndex === -1 ? '' : row[statusIndex];
        if (status === 'deleted') {
            continue;
        }
        if (row[keyIndex] === key && row[scopeIndex] === scope) {
            const rowIndex = i + 2;
            const reminder = await fetchRowByIndex(client, header, headerMap, rowIndex, [
                'id', 'key', 'content', 'scope', 'notify_time_utc', 'recurring', 'status', 'channel_id'
            ]);
            if (reminder.status === 'deleted') {
                return null;
            }
            return { ...reminder, rowIndex };
        }
    }

    return null;
}

/**
 * Adds a new reminder to the sheet.
 * @param {object} reminderData - An object where keys are column names.
 * @returns {Promise<any>}
 */
async function addReminder(reminderData) {
    const client = await getSheetsClient();
    const { header } = await getHeaderData(client);

    const values = [header.map(key => reminderData[key] ?? '')];
    const res = await client.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A1`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        resource: {
            values,
        },
    });

    return res.data;
}

/**
 * Lists reminders for a given scope.
 * @param {string} scope
 * @param {string} [userId] - Required if scope is 'user'
 * @param {string} [channelId] - Required if scope is 'channel'
 * @param {string} [guildId] - Required if scope is 'server'
 * @returns {Promise<object[]>}
 */
async function listReminders(scope, { userId, channelId, guildId }) {
    const client = await getSheetsClient();
    const { header, headerMap } = await getHeaderData(client);
    const { rows, headerSlice } = await fetchRowsByColumns(client, header, headerMap, [
        'key', 'content', 'notify_time_utc', 'scope', 'user_id', 'channel_id', 'guild_id', 'status'
    ]);

    if (!rows || rows.length === 0) {
        return [];
    }

    const reminders = rows.map(row => mapRowToObject(row, headerSlice));
    return reminders.filter(reminder => {
        if (reminder.status === 'deleted') {
            return false;
        }
        if (reminder.scope !== scope) {
            return false;
        }
        switch (scope) {
            case 'user':
                return reminder.user_id === userId;
            case 'channel':
                return reminder.channel_id === channelId;
            case 'server':
                return reminder.guild_id === guildId;
            default:
                return false;
        }
    });
}

/**
 * Marks a reminder as deleted by its unique ID.
 * @param {string} reminderId
 * @returns {Promise<{rowIndex: number, alreadyDeleted?: boolean} | null>}
 */
async function deleteReminderById(reminderId) {
    const client = await getSheetsClient();
    const { header, headerMap } = await getHeaderData(client);
    const result = await findRowIndexById(client, header, headerMap, reminderId, { includeDeleted: true });

    if (!result) {
        return null;
    }

    if (result.status === 'deleted') {
        return { rowIndex: result.rowIndex, alreadyDeleted: true };
    }

    await updateColumnsByRowIndex(client, headerMap, result.rowIndex, { status: 'deleted' });
    return { rowIndex: result.rowIndex };
}

/**
 * Finds a reminder by its unique ID.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
async function getReminderById(id) {
    const client = await getSheetsClient();
    const { header, headerMap } = await getHeaderData(client);
    const { rows, headerSlice } = await fetchRowsByColumns(client, header, headerMap, ['id', 'key', 'scope', 'status', 'channel_id']);

    const idIndex = headerSlice.indexOf('id');
    const statusIndex = headerSlice.indexOf('status');

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const status = statusIndex === -1 ? '' : row[statusIndex];
        if (status === 'deleted') {
            continue;
        }
        if (row[idIndex] === id) {
            const reminder = mapRowToObject(row, headerSlice);
            return { ...reminder, rowIndex: i + 2 };
        }
    }

    return null;
}

/**
 * Fetches all reminders that are due to be sent.
 * @returns {Promise<object[]>}
 */
async function getPendingReminders() {
    const client = await getSheetsClient();
    const { header, headerMap } = await getHeaderData(client);
    const { rows, headerSlice } = await fetchRowsByColumns(client, header, headerMap, [
        'id', 'content', 'scope', 'user_id', 'channel_id', 'guild_id',
        'notify_time_utc', 'recurring', 'retry_count', 'status', 'last_sent'
    ]);

    if (!rows || rows.length === 0) {
        return [];
    }

    const statusIndex = headerSlice.indexOf('status');
    const timeIndex = headerSlice.indexOf('notify_time_utc');
    const lastSentIndex = headerSlice.indexOf('last_sent');
    if (statusIndex === -1 || timeIndex === -1 || lastSentIndex === -1) {
        throw new Error('Sheet must have "status", "notify_time_utc", and "last_sent" columns.');
    }

    const now = new Date();
    const reminders = [];

    rows.forEach((row, i) => {
        const status = row[statusIndex];
        if (status !== 'pending' && status !== 'sending') {
            return;
        }
        const notifyValue = row[timeIndex];
        if (!notifyValue) {
            return;
        }
        const notifyTime = new Date(notifyValue);
        if (Number.isNaN(notifyTime.getTime())) {
            return;
        }
        if (status === 'sending') {
            const lastSentValue = row[lastSentIndex];
            if (!lastSentValue) {
                const reminder = mapRowToObject(row, headerSlice);
                reminders.push({ ...reminder, rowIndex: i + 2 });
                return;
            }
            const lastSentTime = new Date(lastSentValue);
            if (Number.isNaN(lastSentTime.getTime())) {
                const reminder = mapRowToObject(row, headerSlice);
                reminders.push({ ...reminder, rowIndex: i + 2 });
                return;
            }
            if (now.getTime() - lastSentTime.getTime() < SENDING_TIMEOUT_MS) {
                return;
            }
        }
        if (notifyTime <= now) {
            const reminder = mapRowToObject(row, headerSlice);
            reminders.push({ ...reminder, rowIndex: i + 2 });
        }
    });

    return reminders;
}

/**
 * Updates a reminder row with new data.
 * @param {string} reminderId - The reminder ID to update.
 * @param {object} reminderData - An object with the new data.
 * @param {object} [options]
 * @param {number} [options.rowIndex] - Optional 1-based row index hint.
 * @returns {Promise<any>}
 */
async function updateReminder(reminderId, reminderData, options = {}) {
    const client = await getSheetsClient();
    const { header, headerMap } = await getHeaderData(client);
    const idIndex = headerMap.id;

    if (idIndex === undefined) {
        throw new Error('Sheet missing "id" column.');
    }

    let targetRowIndex = options.rowIndex;
    if (targetRowIndex) {
        const idCol = columnIndexToLetter(idIndex);
        const res = await client.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: `${SHEET_NAME}!${idCol}${targetRowIndex}:${idCol}${targetRowIndex}`,
        });
        const rowId = res.data.values && res.data.values[0] && res.data.values[0][0];
        if (rowId !== reminderId) {
            targetRowIndex = null;
        }
    }

    if (!targetRowIndex) {
        const found = await findRowIndexById(client, header, headerMap, reminderId, { includeDeleted: true });
        if (!found) {
            throw new Error(`Reminder with id "${reminderId}" not found.`);
        }
        targetRowIndex = found.rowIndex;
    }

    return updateColumnsByRowIndex(client, headerMap, targetRowIndex, reminderData);
}

module.exports = {
    getSheetsClient,
    getReminderByKey,
    getReminderById,
    addReminder,
    listReminders,
    deleteReminderById,
    getPendingReminders,
    updateReminder,
    SHEET_ID,
    SHEET_NAME,
    SCHEMA,
};
