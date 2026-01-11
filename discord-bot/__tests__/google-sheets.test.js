const fs = require('fs');
const os = require('os');
const path = require('path');

const base64Key = Buffer.from(JSON.stringify({
    client_email: 'test@example.com',
    private_key: 'test-key',
})).toString('base64');

const header = [
    'id', 'key', 'content', 'scope', 'guild_id', 'channel_id', 'user_id',
    'notify_time_utc', 'timezone', 'recurring', 'visibility', 'created_by',
    'created_at', 'status', 'last_sent', 'retry_count', 'metadata'
];

let mockSheets;

jest.mock('google-auth-library', () => ({
    JWT: jest.fn().mockImplementation(() => ({
        getClient: jest.fn().mockResolvedValue({}),
    })),
}));

jest.mock('googleapis', () => ({
    google: {
        sheets: jest.fn(() => mockSheets),
    },
}));

describe('google-sheets', () => {
    beforeEach(() => {
        jest.resetModules();
        mockSheets = {
            spreadsheets: {
                values: {
                    get: jest.fn(),
                    append: jest.fn(),
                    batchUpdate: jest.fn().mockResolvedValue({ data: {} }),
                },
            },
        };
        process.env.GOOGLE_SA_KEY_JSON = base64Key;
        delete process.env.GOOGLE_SA_KEY_PATH;
        process.env.SHEET_ID = 'sheet-id';
    });

    it('returns a reminder when key and scope match', async () => {
        const searchRow = Array(14).fill('');
        searchRow[0] = 'id-1';
        searchRow[1] = 'key-1';
        searchRow[3] = 'user';
        searchRow[13] = 'pending';

        const detailRow = Array(14).fill('');
        detailRow[0] = 'id-1';
        detailRow[1] = 'key-1';
        detailRow[2] = 'Test content';
        detailRow[3] = 'user';
        detailRow[7] = '2026-01-11T10:00:00.000Z';
        detailRow[9] = 'off';
        detailRow[13] = 'pending';

        mockSheets.spreadsheets.values.get.mockImplementation(({ range }) => {
            if (range === 'Reminders!1:1') {
                return Promise.resolve({ data: { values: [header] } });
            }
            if (range === 'Reminders!A2:N') {
                return Promise.resolve({ data: { values: [searchRow] } });
            }
            if (range === 'Reminders!A2:N2') {
                return Promise.resolve({ data: { values: [detailRow] } });
            }
            return Promise.resolve({ data: { values: [] } });
        });

        const { getReminderByKey } = require('../src/google-sheets');
        const reminder = await getReminderByKey('key-1', 'user');

        expect(reminder).toMatchObject({
            id: 'id-1',
            key: 'key-1',
            content: 'Test content',
            scope: 'user',
            notify_time_utc: '2026-01-11T10:00:00.000Z',
            recurring: 'off',
            status: 'pending',
            rowIndex: 2,
        });
    });

    it('marks a reminder as deleted by id', async () => {
        const searchRow = Array(14).fill('');
        searchRow[0] = 'id-1';
        searchRow[13] = 'pending';

        mockSheets.spreadsheets.values.get.mockImplementation(({ range }) => {
            if (range === 'Reminders!1:1') {
                return Promise.resolve({ data: { values: [header] } });
            }
            if (range === 'Reminders!A2:N') {
                return Promise.resolve({ data: { values: [searchRow] } });
            }
            return Promise.resolve({ data: { values: [] } });
        });

        const { deleteReminderById } = require('../src/google-sheets');
        const result = await deleteReminderById('id-1');

        expect(result).toEqual({ rowIndex: 2 });
        expect(mockSheets.spreadsheets.values.batchUpdate).toHaveBeenCalledTimes(1);
        const updateCall = mockSheets.spreadsheets.values.batchUpdate.mock.calls[0][0];
        expect(updateCall.resource.data[0].range).toBe('Reminders!N2:N2');
        expect(updateCall.resource.data[0].values).toEqual([['deleted']]);
    });

    it('initializes with GOOGLE_SA_KEY_PATH', async () => {
        const tmpPath = path.join(os.tmpdir(), `sa-key-${Date.now()}.json`);
        fs.writeFileSync(tmpPath, JSON.stringify({
            client_email: 'test@example.com',
            private_key: 'test-key',
        }));
        delete process.env.GOOGLE_SA_KEY_JSON;
        process.env.GOOGLE_SA_KEY_PATH = tmpPath;

        try {
            const { getSheetsClient } = require('../src/google-sheets');
            const client = await getSheetsClient();
            expect(client).toBe(mockSheets);
        } finally {
            fs.unlinkSync(tmpPath);
        }
    });
});
