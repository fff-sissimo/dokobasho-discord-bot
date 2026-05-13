const chrono = require('chrono-node');
const sheets = require('../src/google-sheets');
const { generateReminderKey } = require('../src/reminder-key');
const {
  createResourceServer,
  addReminderFromPayload,
  listRemindersFromPayload,
  deleteReminderFromPayload,
} = require('../resource-server');
const { MESSAGES } = require('../src/message-templates');

jest.mock('../src/google-sheets', () => ({
  getSheetsClient: jest.fn().mockResolvedValue(true),
  getReminderByKey: jest.fn(),
  addReminder: jest.fn(),
  listReminders: jest.fn(),
  deleteReminderById: jest.fn(),
}));

jest.mock('chrono-node', () => ({
  parseDate: jest.fn(),
}));

jest.mock('../src/reminder-key', () => ({
  generateReminderKey: jest.fn(),
}));

const postJson = async (url, body, headers = {}) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) };
};

describe('resource server reminder bridge', () => {
  const fixedNow = new Date('2026-05-13T00:00:00.000Z');

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DEFAULT_TZ = 'JST';
    sheets.getSheetsClient.mockResolvedValue(true);
    sheets.getReminderByKey.mockResolvedValue(null);
    sheets.addReminder.mockResolvedValue({ updates: { updatedCells: 1 } });
    sheets.listReminders.mockResolvedValue([]);
    sheets.deleteReminderById.mockResolvedValue({ rowIndex: 2 });
    generateReminderKey.mockReturnValue('K7M2Z9H4');
    chrono.parseDate.mockReturnValue(new Date('2026-05-13T01:00:00.000Z'));
  });

  afterEach(() => {
    delete process.env.DEFAULT_TZ;
  });

  it('adds a user reminder from a JSON payload', async () => {
    const result = await addReminderFromPayload({
      user_id: 'user-1',
      guild_id: 'guild-1',
      channel_id: 'channel-1',
      time: '10分後',
      content: '水を飲む',
    }, { now: () => fixedNow });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('created');
    expect(result.reply_content).toContain('✅ リマインダーを登録したよ！');
    expect(chrono.parseDate).toHaveBeenCalledWith(
      'in 10 minutes',
      expect.objectContaining({ instant: fixedNow, timezone: 540 }),
      { forwardDate: true }
    );
    expect(sheets.addReminder).toHaveBeenCalledTimes(1);
    expect(sheets.addReminder.mock.calls[0][0]).toMatchObject({
      key: 'K7M2Z9H4',
      content: '水を飲む',
      scope: 'user',
      user_id: 'user-1',
      channel_id: '',
      notify_time_utc: '2026-05-13T01:00:00.000Z',
      status: 'pending',
    });
  });

  it('rejects server reminder add without admin permission', async () => {
    const result = await addReminderFromPayload({
      user_id: 'user-1',
      guild_id: 'guild-1',
      channel_id: 'channel-1',
      target_channel_id: 'channel-2',
      scope: 'server',
      time: '明日10時',
      content: 'server reminder',
      is_admin: false,
    }, { now: () => fixedNow });

    expect(result).toMatchObject({
      ok: false,
      code: 'admin_required',
      reply_content: MESSAGES.responses.adminRequiredForCreate,
    });
    expect(sheets.addReminder).not.toHaveBeenCalled();
  });

  it('lists reminders and returns discord-ready reply content', async () => {
    sheets.listReminders.mockResolvedValue([
      { key: 'ABCDEFGH', content: '買い物に行く', notify_time_utc: '2026-05-13T02:00:00.000Z' },
      { key: 'ZZZZZZZZ', content: '別件', notify_time_utc: '2026-05-13T03:00:00.000Z' },
    ]);

    const result = await listRemindersFromPayload({
      scope: 'user',
      user_id: 'user-1',
      query: '買い物',
      limit: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.total).toBe(1);
    expect(result.reminders).toHaveLength(1);
    expect(result.reply_content).toContain('ABCDEFGH');
    expect(sheets.listReminders).toHaveBeenCalledWith('user', {
      userId: 'user-1',
      channelId: '',
      guildId: '',
    });
  });

  it('deletes a reminder by key and scope', async () => {
    sheets.getReminderByKey.mockResolvedValue({ id: 'reminder-1', key: 'ABCDEFGH' });

    const result = await deleteReminderFromPayload({
      scope: 'user',
      key: 'ABCDEFGH',
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('deleted');
    expect(result.reply_content).toBe(MESSAGES.responses.deleteSuccess('ABCDEFGH'));
    expect(sheets.deleteReminderById).toHaveBeenCalledWith('reminder-1');
  });

  it('protects internal API with x-resource-api-token when configured', async () => {
    const runtime = await createResourceServer({ port: 0, host: '127.0.0.1', token: 'secret-token' }).start();
    try {
      const base = `http://127.0.0.1:${runtime.port}`;
      const unauthorized = await postJson(`${base}/internal/remind/list`, { scope: 'user', user_id: 'user-1' });
      expect(unauthorized.status).toBe(401);

      const authorized = await postJson(
        `${base}/internal/remind/list`,
        { scope: 'user', user_id: 'user-1' },
        { 'x-resource-api-token': 'secret-token' }
      );
      expect(authorized.status).toBe(200);
      expect(authorized.body.ok).toBe(true);
    } finally {
      await runtime.stop();
    }
  });
});
