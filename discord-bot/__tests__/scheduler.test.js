const mockScheduled = [];
const mockLogin = jest.fn().mockResolvedValue(undefined);
const mockOnce = jest.fn();
const mockGetBotToken = jest.fn(() => 'token');

jest.mock('node-cron', () => ({
  schedule: jest.fn((expression, callback) => {
    mockScheduled.push({ expression, callback });
    return { stop: jest.fn() };
  }),
}));

jest.mock('discord.js', () => ({
  Client: jest.fn(() => ({ once: mockOnce, login: mockLogin, user: { tag: 'bot' } })),
  GatewayIntentBits: { Guilds: 1 },
}));

jest.mock('../src/config', () => ({ getBotToken: mockGetBotToken }));
jest.mock('../src/reminder-processor', () => ({ processReminders: jest.fn() }));
jest.mock('../src/scheduler-heartbeat', () => ({ writeHeartbeat: jest.fn() }));
jest.mock('../src/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('scheduler entrypoint', () => {
  beforeEach(() => {
    mockScheduled.length = 0;
    jest.clearAllMocks();
  });

  test('has no login side effect when imported for tests or tooling', () => {
    const scheduler = require('../scheduler');

    expect(scheduler.scheduleReminderProcessing).toEqual(expect.any(Function));
    expect(scheduler.startScheduler).toEqual(expect.any(Function));
    expect(mockGetBotToken).not.toHaveBeenCalled();
    expect(mockLogin).not.toHaveBeenCalled();
  });
});
