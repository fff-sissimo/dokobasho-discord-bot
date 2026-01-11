// __tests__/reminder-processor.test.js

const { processReminders } = require('../src/reminder-processor');
const sheets = require('../src/google-sheets');
const utils = require('../src/utils');
const { MESSAGES } = require('../src/message-templates');

// Mock external modules
jest.mock('../src/google-sheets');
jest.mock('../src/utils');
jest.mock('../src/logger', () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));


describe('Reminder Processor', () => {
    let mockDiscordClient;

    beforeEach(() => {
        jest.clearAllMocks();
        sheets.updateReminder.mockReset();

        mockDiscordClient = {
            users: {
                fetch: jest.fn().mockResolvedValue({ send: jest.fn().mockResolvedValue(true) }),
            },
            channels: {
                fetch: jest.fn().mockResolvedValue({ send: jest.fn().mockResolvedValue(true) }),
            }
        };

        sheets.getSheetsClient.mockResolvedValue(true);
        sheets.getPendingReminders.mockResolvedValue([]);
        sheets.updateReminder.mockResolvedValue(true);
        utils.calculateNextDate.mockImplementation((isoDate) => {
            const date = new Date(isoDate);
            date.setDate(date.getDate() + 1); // Simple mock for next day
            return date.toISOString();
        });
    });

    it('should not process if no reminders are due', async () => {
        await processReminders(mockDiscordClient);
        expect(sheets.getPendingReminders).toHaveBeenCalledTimes(1);
        expect(sheets.updateReminder).not.toHaveBeenCalled();
    });

    it('should process a non-recurring reminder', async () => {
        const reminder = {
            id: 'id-1', key: 'user-rem', content: 'User reminder', scope: 'user',
            user_id: 'user-abc', notify_time_utc: new Date('2026-01-10T10:00:00.000Z').toISOString(),
            recurring: 'off', status: 'pending', retry_count: 0, rowIndex: 2,
        };
        sheets.getPendingReminders.mockResolvedValue([reminder]);

        await processReminders(mockDiscordClient);

        expect(sheets.updateReminder).toHaveBeenCalledTimes(2);

        // 1. Lock
        expect(sheets.updateReminder).toHaveBeenNthCalledWith(
            1,
            reminder.id,
            { status: 'sending', last_sent: expect.any(String) },
            { rowIndex: reminder.rowIndex }
        );

        // 2. Send
        expect(mockDiscordClient.users.fetch).toHaveBeenCalledWith('user-abc');
        expect((await mockDiscordClient.users.fetch()).send).toHaveBeenCalledWith(
            MESSAGES.reminders.notification('User reminder')
        );

        // 3. Mark as sent
        const secondCallArg = sheets.updateReminder.mock.calls[1][1];
        expect(sheets.updateReminder.mock.calls[1][0]).toBe(reminder.id);
        expect(sheets.updateReminder.mock.calls[1][2]).toEqual({ rowIndex: reminder.rowIndex });
        expect(secondCallArg.status).toBe('sent');
        expect(secondCallArg.last_sent).toEqual(expect.any(String));
    });

    it('should process a recurring reminder', async () => {
        const reminder = {
            id: 'id-2', key: 'chan-rem', content: 'Channel reminder', scope: 'channel',
            channel_id: 'channel-xyz', notify_time_utc: new Date('2026-01-10T10:00:00.000Z').toISOString(),
            recurring: 'daily', status: 'pending', retry_count: 0, rowIndex: 3,
        };
        sheets.getPendingReminders.mockResolvedValue([reminder]);

        await processReminders(mockDiscordClient);

        expect(sheets.updateReminder).toHaveBeenCalledTimes(2);
        
        // 1. Lock
        expect(sheets.updateReminder).toHaveBeenNthCalledWith(
            1,
            reminder.id,
            { status: 'sending', last_sent: expect.any(String) },
            { rowIndex: reminder.rowIndex }
        );
        
        // 2. Send
        expect(mockDiscordClient.channels.fetch).toHaveBeenCalledWith('channel-xyz');
        expect((await mockDiscordClient.channels.fetch()).send).toHaveBeenCalledWith(
            MESSAGES.reminders.notification('Channel reminder')
        );

        // 3. Reschedule
        expect(utils.calculateNextDate).toHaveBeenCalledWith(reminder.notify_time_utc, 'daily');
        const secondCallArg = sheets.updateReminder.mock.calls[1][1];
        expect(sheets.updateReminder.mock.calls[1][0]).toBe(reminder.id);
        expect(sheets.updateReminder.mock.calls[1][2]).toEqual({ rowIndex: reminder.rowIndex });
        expect(secondCallArg.status).toBe('pending');
        expect(secondCallArg.notify_time_utc).not.toBe(reminder.notify_time_utc);
        expect(secondCallArg.last_sent).toEqual(expect.any(String));
    });

    it('should send a server reminder to the configured channel', async () => {
        const reminder = {
            id: 'id-server', key: 'server-rem', content: 'Server reminder', scope: 'server',
            channel_id: 'channel-server', notify_time_utc: new Date('2026-01-10T10:00:00.000Z').toISOString(),
            recurring: 'off', status: 'pending', retry_count: 0, rowIndex: 6,
        };
        sheets.getPendingReminders.mockResolvedValue([reminder]);

        await processReminders(mockDiscordClient);

        expect(mockDiscordClient.channels.fetch).toHaveBeenCalledWith('channel-server');
        expect((await mockDiscordClient.channels.fetch()).send).toHaveBeenCalledWith(
            MESSAGES.reminders.notification('Server reminder')
        );
    });

    it('should retry a failed reminder', async () => {
        const reminder = {
            id: 'id-3', key: 'fail-rem', content: 'Failing reminder', scope: 'user',
            user_id: 'user-def', notify_time_utc: new Date().toISOString(),
            recurring: 'off', status: 'pending', retry_count: 0, rowIndex: 4,
        };
        sheets.getPendingReminders.mockResolvedValue([reminder]);
        mockDiscordClient.users.fetch.mockRejectedValue(new Error('Discord send failed'));

        await processReminders(mockDiscordClient);

        expect(sheets.updateReminder).toHaveBeenCalledTimes(2);

        // 1. Lock
        expect(sheets.updateReminder).toHaveBeenNthCalledWith(
            1,
            reminder.id,
            { status: 'sending', last_sent: expect.any(String) },
            { rowIndex: reminder.rowIndex }
        );
        
        // 2. Handle failure
        const secondCallArg = sheets.updateReminder.mock.calls[1][1];
        expect(sheets.updateReminder.mock.calls[1][0]).toBe(reminder.id);
        expect(sheets.updateReminder.mock.calls[1][2]).toEqual({ rowIndex: reminder.rowIndex });
        expect(secondCallArg.status).toBe('pending');
        expect(secondCallArg.retry_count).toBe(1);
    });

    it('should mark a reminder as failed after max retries', async () => {
        const reminder = {
            id: 'id-4', key: 'max-fail', content: 'Max retry reminder', scope: 'user',
            user_id: 'user-ghi', notify_time_utc: new Date().toISOString(),
            recurring: 'off', status: 'pending', retry_count: 2, rowIndex: 5,
        };
        sheets.getPendingReminders.mockResolvedValue([reminder]);
        mockDiscordClient.users.fetch.mockRejectedValue(new Error('Discord send failed again'));

        await processReminders(mockDiscordClient);

        expect(sheets.updateReminder).toHaveBeenCalledTimes(2);

        // 1. Lock
        expect(sheets.updateReminder).toHaveBeenNthCalledWith(
            1,
            reminder.id,
            { status: 'sending', last_sent: expect.any(String) },
            { rowIndex: reminder.rowIndex }
        );
        
        // 2. Handle failure
        const secondCallArg = sheets.updateReminder.mock.calls[1][1];
        expect(sheets.updateReminder.mock.calls[1][0]).toBe(reminder.id);
        expect(sheets.updateReminder.mock.calls[1][2]).toEqual({ rowIndex: reminder.rowIndex });
        expect(secondCallArg.status).toBe('failed');
        expect(secondCallArg.retry_count).toBe(3);
    });
});
