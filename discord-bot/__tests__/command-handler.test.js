// __tests__/command-handler.test.js

const { handleCommand, handleButton } = require('../src/command-handler');
const sheets = require('../src/google-sheets');
const chrono = require('chrono-node');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js"); // Required for testing button interactions
const { MESSAGES } = require('../src/message-templates');
const { generateReminderKey } = require('../src/reminder-key');

const supportsIanaTimeZone = (timeZone) => {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone }).format();
        return true;
    } catch (error) {
        return false;
    }
};

// Mock the entire google-sheets module
jest.mock('../src/google-sheets', () => ({
    getSheetsClient: jest.fn().mockResolvedValue(true),
    getReminderByKey: jest.fn(),
    getReminderById: jest.fn(),
    addReminder: jest.fn(),
    listReminders: jest.fn(),
    deleteReminderById: jest.fn(),
    updateReminder: jest.fn(),
}));

// Mock chrono-node to return a fixed date or null
jest.mock('chrono-node', () => ({
    parseDate: jest.fn(),
}));

jest.mock('../src/reminder-key', () => ({
    generateReminderKey: jest.fn(),
}));

// Mock discord.js ActionRowBuilder and ButtonBuilder
jest.mock('discord.js', () => {
    const actualDiscord = jest.requireActual('discord.js');
    const mockButtonBuilder = {
        setCustomId: jest.fn().mockReturnThis(),
        setLabel: jest.fn().mockReturnThis(),
        setStyle: jest.fn().mockReturnThis(),
        toJSON: jest.fn().mockReturnValue({ type: 2 }), // type 2 is Button
    };
    const mockActionRowBuilder = {
        addComponents: jest.fn().mockReturnThis(),
        toJSON: jest.fn().mockReturnValue({ type: 1, components: [mockButtonBuilder.toJSON()] }), // type 1 is ActionRow
    };
    return {
        ...actualDiscord,
        ActionRowBuilder: jest.fn(() => mockActionRowBuilder),
        ButtonBuilder: jest.fn(() => mockButtonBuilder),
        ButtonStyle: actualDiscord.ButtonStyle,
    };
});


describe('Command Handler Integration Tests', () => {
    let mockInteraction;
    let originalDefaultTz;
    const commonMockInteractionProps = {
        deferReply: jest.fn().mockResolvedValue(true),
        editReply: jest.fn().mockResolvedValue(true),
        deferUpdate: jest.fn().mockResolvedValue(true),
        update: jest.fn().mockResolvedValue(true),
        user: { id: 'user-123' },
        guild: { id: 'guild-456' },
        channel: { id: 'channel-789' },
        member: { permissions: { has: jest.fn().mockReturnValue(false) } } // Default to no admin perms
    };

    beforeEach(() => {
        jest.clearAllMocks(); // Clear all mocks before each test
        originalDefaultTz = process.env.DEFAULT_TZ;
        process.env.DEFAULT_TZ = 'JST';
        mockInteraction = {
            ...commonMockInteractionProps,
            options: {
                getSubcommand: jest.fn(),
                getString: jest.fn(),
                getBoolean: jest.fn(),
                getInteger: jest.fn(),
                getChannel: jest.fn(),
            },
        };

        sheets.getSheetsClient.mockResolvedValue(true); // Ensure sheets client always initializes
        sheets.getReminderByKey.mockResolvedValue(null);
        generateReminderKey.mockReturnValue('K7M2Z9H4');
    });

    afterEach(() => {
        if (originalDefaultTz === undefined) {
            delete process.env.DEFAULT_TZ;
        } else {
            process.env.DEFAULT_TZ = originalDefaultTz;
        }
    });

    describe('/remind add', () => {
        beforeEach(() => {
            mockInteraction.options.getSubcommand.mockReturnValue('add');
        });

        it('should add a new reminder successfully', async () => {
            mockInteraction.options.getString.mockImplementation(opt => {
                const options = { time: 'tomorrow at 10am', content: 'This is a test reminder' };
                return options[opt] ?? null;
            });

            const fakeDate = new Date('2026-01-11T10:00:00.000Z');
            chrono.parseDate.mockReturnValue(fakeDate);
            sheets.addReminder.mockResolvedValue({ updates: { updatedCells: 1 } });

            await handleCommand(mockInteraction);

            expect(sheets.addReminder).toHaveBeenCalledTimes(1);
            const newReminder = sheets.addReminder.mock.calls[0][0];
            expect(newReminder).toMatchObject({
                content: 'This is a test reminder', scope: 'user', user_id: 'user-123',
                notify_time_utc: fakeDate.toISOString(), status: 'pending',
            });
            expect(newReminder.key).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
            const reply = mockInteraction.editReply.mock.calls[0][0];
            const displayDate = `<t:${Math.floor(fakeDate.getTime() / 1000)}:F>`;
            expect(reply.content).toBe(MESSAGES.responses.created(newReminder.key, displayDate));
        });

        it('should retry key generation when a collision is detected', async () => {
            mockInteraction.options.getString.mockImplementation(opt => {
                const options = { time: 'tomorrow at 10am', content: 'Collision test reminder' };
                return options[opt] ?? null;
            });

            const fakeDate = new Date('2026-01-11T10:00:00.000Z');
            chrono.parseDate.mockReturnValue(fakeDate);
            sheets.addReminder.mockResolvedValue({ updates: { updatedCells: 1 } });
            generateReminderKey
                .mockReturnValueOnce('K7M2Z9H4')
                .mockReturnValueOnce('Z9H4K7M2');
            sheets.getReminderByKey
                .mockResolvedValueOnce({ id: 'existing-reminder' })
                .mockResolvedValueOnce(null);

            await handleCommand(mockInteraction);

            expect(sheets.getReminderByKey).toHaveBeenNthCalledWith(1, 'K7M2Z9H4', 'user');
            expect(sheets.getReminderByKey).toHaveBeenNthCalledWith(2, 'Z9H4K7M2', 'user');
            const newReminder = sheets.addReminder.mock.calls[0][0];
            expect(newReminder.key).toBe('Z9H4K7M2');
        });

        it('should require a channel for server scope', async () => {
            mockInteraction.options.getString.mockImplementation(opt => {
                const options = { time: 'tomorrow at 10am', content: 'Server reminder', scope: 'server' };
                return options[opt] ?? null;
            });
            mockInteraction.options.getChannel.mockReturnValue(null);
            mockInteraction.member.permissions.has.mockReturnValue(true);

            await handleCommand(mockInteraction);

            expect(sheets.addReminder).not.toHaveBeenCalled();
            const reply = mockInteraction.editReply.mock.calls[0][0];
            expect(reply.content).toBe(MESSAGES.responses.channelRequiredForServerScope);
        });

        it('should add a server reminder with a target channel', async () => {
            mockInteraction.options.getString.mockImplementation(opt => {
                const options = { time: 'tomorrow at 10am', content: 'Server reminder', scope: 'server' };
                return options[opt] ?? null;
            });
            mockInteraction.options.getChannel.mockReturnValue({ id: 'channel-999' });
            mockInteraction.member.permissions.has.mockReturnValue(true);

            const fakeDate = new Date('2026-01-11T10:00:00.000Z');
            chrono.parseDate.mockReturnValue(fakeDate);
            sheets.addReminder.mockResolvedValue({ updates: { updatedCells: 1 } });

            await handleCommand(mockInteraction);

            const newReminder = sheets.addReminder.mock.calls[0][0];
            expect(newReminder).toMatchObject({
                scope: 'server',
                channel_id: 'channel-999',
            });
        });

        it('should fail if the time is invalid', async () => {
            mockInteraction.options.getString.mockImplementation(opt => {
                const options = { time: 'invalid time', content: 'test' };
                return options[opt];
            });
            chrono.parseDate.mockReturnValue(null);

            await handleCommand(mockInteraction);

            expect(sheets.addReminder).not.toHaveBeenCalled();
            const reply = mockInteraction.editReply.mock.calls[0][0];
            expect(reply.content).toBe(MESSAGES.errors.invalidTime);
        });

        it('should reject invalid timezone input', async () => {
            mockInteraction.options.getString.mockImplementation(opt => {
                const options = {
                    time: 'tomorrow at 10am',
                    content: 'Invalid timezone reminder',
                    timezone: 'Invalid/Zone',
                };
                return options[opt] ?? null;
            });

            await handleCommand(mockInteraction);

            expect(chrono.parseDate).not.toHaveBeenCalled();
            expect(sheets.addReminder).not.toHaveBeenCalled();
            const reply = mockInteraction.editReply.mock.calls[0][0];
            expect(reply.content).toBe(MESSAGES.errors.invalidTimezone);
        });

        it('should parse time with a UTC offset timezone', async () => {
            mockInteraction.options.getString.mockImplementation(opt => {
                const options = {
                    time: 'tomorrow at 10am',
                    content: 'Offset reminder',
                    timezone: '+08:00',
                };
                return options[opt] ?? null;
            });

            const fakeDate = new Date('2026-01-11T10:00:00.000Z');
            chrono.parseDate.mockReturnValue(fakeDate);
            sheets.addReminder.mockResolvedValue({ updates: { updatedCells: 1 } });

            await handleCommand(mockInteraction);

            expect(chrono.parseDate).toHaveBeenCalledWith(
                'tomorrow at 10am',
                expect.objectContaining({ timezone: 480 }),
                { forwardDate: true }
            );
            const newReminder = sheets.addReminder.mock.calls[0][0];
            expect(newReminder.timezone).toBe('+08:00');
        });

        it('should use an IANA timezone label', async () => {
            mockInteraction.options.getString.mockImplementation(opt => {
                const options = {
                    time: 'tomorrow at 10am',
                    content: 'IANA reminder',
                    timezone: 'Asia/Tokyo',
                };
                return options[opt] ?? null;
            });

            const fakeDate = new Date('2026-01-11T10:00:00.000Z');
            chrono.parseDate.mockReturnValue(fakeDate);
            sheets.addReminder.mockResolvedValue({ updates: { updatedCells: 1 } });

            await handleCommand(mockInteraction);

            const newReminder = sheets.addReminder.mock.calls[0][0];
            expect(newReminder.timezone).toBe('Asia/Tokyo');
        });

        const itIfIana = supportsIanaTimeZone('America/New_York') ? it : it.skip;
        itIfIana('should adjust for DST when using an IANA timezone', async () => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-01-10T00:00:00.000Z'));
            try {
                mockInteraction.options.getString.mockImplementation(opt => {
                    const options = {
                        time: '2026-07-01 10:00',
                        content: 'DST reminder',
                        timezone: 'America/New_York',
                    };
                    return options[opt] ?? null;
                });

                const parsedDate = new Date('2026-07-01T15:00:00.000Z');
                chrono.parseDate.mockReturnValue(parsedDate);
                sheets.addReminder.mockResolvedValue({ updates: { updatedCells: 1 } });

                await handleCommand(mockInteraction);

                const newReminder = sheets.addReminder.mock.calls[0][0];
                expect(newReminder.notify_time_utc).toBe('2026-07-01T14:00:00.000Z');
            } finally {
                jest.useRealTimers();
            }
        });

        it('should fall back to DEFAULT_TZ when timezone is omitted', async () => {
            process.env.DEFAULT_TZ = 'UTC';
            mockInteraction.options.getString.mockImplementation(opt => {
                const options = {
                    time: 'tomorrow at 10am',
                    content: 'Default timezone reminder',
                };
                return options[opt] ?? null;
            });

            const fakeDate = new Date('2026-01-11T10:00:00.000Z');
            chrono.parseDate.mockReturnValue(fakeDate);
            sheets.addReminder.mockResolvedValue({ updates: { updatedCells: 1 } });

            await handleCommand(mockInteraction);

            expect(chrono.parseDate).toHaveBeenCalledWith(
                'tomorrow at 10am',
                expect.objectContaining({ timezone: 0 }),
                { forwardDate: true }
            );
            const newReminder = sheets.addReminder.mock.calls[0][0];
            expect(newReminder.timezone).toBe('UTC');
        });
    });

    describe('/remind get (disabled)', () => {
        beforeEach(() => {
            mockInteraction.options.getSubcommand.mockReturnValue('get');
        });

        it('should return a disabled message', async () => {
            await handleCommand(mockInteraction);

            expect(sheets.getReminderByKey).not.toHaveBeenCalled();
            const reply = mockInteraction.editReply.mock.calls[0][0];
            expect(reply.content).toBe(MESSAGES.responses.getDisabled);
        });
    });

    describe('/remind list', () => {
        beforeEach(() => {
            mockInteraction.options.getSubcommand.mockReturnValue('list');
        });

        it('should list all reminders for the given scope', async () => {
            const mockReminders = [
                { key: 'task1', content: 'Do X', notify_time_utc: '2026-01-11T10:00:00.000Z' },
                { key: 'task2', content: 'Do Y', notify_time_utc: '2026-01-12T10:00:00.000Z' },
            ];
            mockInteraction.options.getString.mockImplementation(opt => {
                if (opt === 'scope') return 'user';
                return null;
            });
            mockInteraction.options.getInteger.mockReturnValue(10); // limit
            sheets.listReminders.mockResolvedValue(mockReminders);

            await handleCommand(mockInteraction);

            expect(sheets.listReminders).toHaveBeenCalledWith('user', {
                userId: mockInteraction.user.id,
                channelId: mockInteraction.channel.id,
                guildId: mockInteraction.guild.id,
            });
            const reply = mockInteraction.editReply.mock.calls[0][0];
            const listContent = [
                MESSAGES.responses.listItem('task1', 'Do X', '<t:1768125600:R>'),
                MESSAGES.responses.listItem('task2', 'Do Y', '<t:1768212000:R>'),
            ].join('\n');
            expect(reply.content).toBe(MESSAGES.responses.listHeader('user', 2, 2, listContent));
        });

        it('should list reminders filtered by query', async () => {
            const mockReminders = [
                { key: 'task1', content: 'Meeting sync', notify_time_utc: '2026-01-11T10:00:00.000Z' },
                { key: 'task2', content: 'Do Y', notify_time_utc: '2026-01-12T10:00:00.000Z' },
            ];
            mockInteraction.options.getString.mockImplementation(opt => {
                if (opt === 'scope') return 'user';
                if (opt === 'query') return 'Meeting';
                return null;
            });
            mockInteraction.options.getInteger.mockReturnValue(10); // limit
            sheets.listReminders.mockResolvedValue(mockReminders);

            await handleCommand(mockInteraction);

            const reply = mockInteraction.editReply.mock.calls[0][0];
            const listContent = MESSAGES.responses.listItem('task1', 'Meeting sync', '<t:1768125600:R>');
            expect(reply.content).toBe(MESSAGES.responses.listHeader('user', 1, 1, listContent));
        });

        it('should reply that no reminders were found', async () => {
            mockInteraction.options.getString.mockReturnValue('user');
            sheets.listReminders.mockResolvedValue([]);

            await handleCommand(mockInteraction);

            const reply = mockInteraction.editReply.mock.calls[0][0];
            expect(reply.content).toBe(MESSAGES.responses.listEmpty);
        });
    });

    describe('/remind delete', () => {
        beforeEach(() => {
            mockInteraction.options.getSubcommand.mockReturnValue('delete');
        });

        it('should delete a reminder if confirm is true', async () => {
            const mockReminder = { id: 'reminder-id-1', key: 'delete-me', scope: 'user' };
            mockInteraction.options.getString.mockImplementation(opt => {
                const options = { key: 'delete-me', scope: 'user' };
                return options[opt];
            });
            mockInteraction.options.getBoolean.mockReturnValue(true); // confirm = true
            sheets.getReminderByKey.mockResolvedValue(mockReminder);
            sheets.deleteReminderById.mockResolvedValue({ rowIndex: 5 });

            await handleCommand(mockInteraction);

            expect(sheets.getReminderByKey).toHaveBeenCalledWith('delete-me', 'user');
            expect(sheets.deleteReminderById).toHaveBeenCalledWith('reminder-id-1');
            const reply = mockInteraction.editReply.mock.calls[0][0];
            expect(reply.content).toBe(MESSAGES.responses.deleteSuccess('delete-me'));
        });

        it('should display a confirmation button if confirm is false', async () => {
            const mockReminder = { id: 'reminder-id-1', key: 'delete-me', scope: 'user' };
            mockInteraction.options.getString.mockImplementation(opt => {
                const options = { key: 'delete-me', scope: 'user' };
                return options[opt];
            });
            mockInteraction.options.getBoolean.mockReturnValue(false); // confirm = false
            sheets.getReminderByKey.mockResolvedValue(mockReminder);

            await handleCommand(mockInteraction);

            expect(sheets.getReminderByKey).toHaveBeenCalledWith('delete-me', 'user');
            expect(sheets.deleteReminderById).not.toHaveBeenCalled();
            const reply = mockInteraction.editReply.mock.calls[0][0];
            expect(reply.content).toBe(MESSAGES.responses.deleteConfirm('delete-me'));
            expect(reply.components).toBeDefined();
            expect(ActionRowBuilder).toHaveBeenCalledTimes(1);
            expect(ButtonBuilder).toHaveBeenCalledTimes(1);
        });

        it('should fail if no reminder is found for deletion', async () => {
            mockInteraction.options.getString.mockImplementation(opt => {
                const options = { key: 'non-existent', scope: 'user' };
                return options[opt];
            });
            mockInteraction.options.getBoolean.mockReturnValue(true); // confirm = true
            sheets.getReminderByKey.mockResolvedValue(null);

            await handleCommand(mockInteraction);

            expect(sheets.deleteReminderById).not.toHaveBeenCalled();
            const reply = mockInteraction.editReply.mock.calls[0][0];
            expect(reply.content).toBe(MESSAGES.responses.notFound);
        });

        it('should deny deletion for server scope without admin permissions', async () => {
            mockInteraction.options.getString.mockImplementation(opt => {
                const options = { key: 'server-rem', scope: 'server' };
                return options[opt];
            });
            mockInteraction.options.getBoolean.mockReturnValue(true); // confirm = true
            mockInteraction.member.permissions.has.mockReturnValue(false); // No admin
            sheets.getReminderByKey.mockResolvedValue({ key: 'server-rem', scope: 'server' });

            await handleCommand(mockInteraction);

            expect(mockInteraction.member.permissions.has).toHaveBeenCalledWith('Administrator');
            expect(sheets.deleteReminderById).not.toHaveBeenCalled();
            const reply = mockInteraction.editReply.mock.calls[0][0];
            expect(reply.content).toBe(MESSAGES.responses.adminRequiredForDelete);
        });

        it('should allow deletion for server scope with admin permissions', async () => {
            const mockReminder = { id: 'reminder-id-server', key: 'server-rem', scope: 'server' };
            mockInteraction.options.getString.mockImplementation(opt => {
                const options = { key: 'server-rem', scope: 'server' };
                return options[opt];
            });
            mockInteraction.options.getBoolean.mockReturnValue(true); // confirm = true
            mockInteraction.member.permissions.has.mockReturnValue(true); // Has admin
            sheets.getReminderByKey.mockResolvedValue(mockReminder);
            sheets.deleteReminderById.mockResolvedValue({ rowIndex: 5 });

            await handleCommand(mockInteraction);

            expect(mockInteraction.member.permissions.has).toHaveBeenCalledWith('Administrator');
            expect(sheets.deleteReminderById).toHaveBeenCalledWith('reminder-id-server');
            const reply = mockInteraction.editReply.mock.calls[0][0];
            expect(reply.content).toBe(MESSAGES.responses.deleteSuccess('server-rem'));
        });
    });

    describe('delete confirmation button handler', () => {
        it('should delete the reminder when the button is pressed', async () => {
            const mockReminder = { id: 'reminder-id-abc', key: 'button-delete', scope: 'user' };
            mockInteraction.customId = 'delete-confirm_reminder-id-abc';
            mockInteraction.isButton = jest.fn().mockReturnValue(true); // Mock isButton

            sheets.getReminderById.mockResolvedValue(mockReminder);
            sheets.deleteReminderById.mockResolvedValue({ rowIndex: 10 });

            await handleButton(mockInteraction);

            expect(sheets.getReminderById).toHaveBeenCalledWith('reminder-id-abc');
            expect(sheets.deleteReminderById).toHaveBeenCalledWith('reminder-id-abc');
            const reply = mockInteraction.editReply.mock.calls[0][0];
            expect(reply.content).toBe(MESSAGES.responses.deleteSuccess('button-delete'));
            expect(reply.components).toEqual([]); // Components should be removed
        });

        it('should indicate reminder already deleted if not found by ID', async () => {
            mockInteraction.customId = 'delete-confirm_non-existent-id';
            mockInteraction.isButton = jest.fn().mockReturnValue(true);

            sheets.getReminderById.mockResolvedValue(null);

            await handleButton(mockInteraction);

            expect(sheets.deleteReminderById).not.toHaveBeenCalled();
            const reply = mockInteraction.editReply.mock.calls[0][0];
            expect(reply.content).toBe(MESSAGES.responses.alreadyDeleted);
        });

        it('should deny button deletion for server scope without admin permissions', async () => {
            const mockReminder = { id: 'reminder-id-server', key: 'server-rem-button', scope: 'server', rowIndex: 15 };
            mockInteraction.customId = 'delete-confirm_reminder-id-server';
            mockInteraction.isButton = jest.fn().mockReturnValue(true);
            mockInteraction.member.permissions.has.mockReturnValue(false); // No admin

            sheets.getReminderById.mockResolvedValue(mockReminder);

            await handleButton(mockInteraction);

            expect(mockInteraction.member.permissions.has).toHaveBeenCalledWith('Administrator');
            expect(sheets.deleteReminderById).not.toHaveBeenCalled();
            const reply = mockInteraction.editReply.mock.calls[0][0];
            expect(reply.content).toBe(MESSAGES.responses.adminRequiredForDelete);
        });
    });
});
