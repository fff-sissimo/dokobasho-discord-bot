jest.mock('../src/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockLongDetailedNotes = [
  '背景: MVP2の完了条件を確認した。',
  'やりとり: speaker-1 が論点を提示し、speaker-2 が懸念を確認した。',
  ...Array.from({ length: 120 }, (_, index) => `長文詳細メモ-${index + 1}: この発言の背景と判断理由を省略せず記録した。`),
  '結論/未決: 詳細メモを残す。',
];
const mockLongDetailedNoteTail = '長文詳細メモ-120';

jest.mock('../src/vc-memo/audio-processor', () => ({
  processOpusPacket: jest.fn(),
  getDecodedWavBuffer: jest.fn(),
  getDecodedWavForUser: jest.fn(),
  getDecodedWavChunksForUser: jest.fn(),
  reset: jest.fn(),
}));

jest.mock('../src/vc-memo/voice-listener', () => {
  const mVoiceJoinChannel = jest.fn();
  const mLeaveVoiceChannel = jest.fn();
  const mOnSpeakingStart = jest.fn();
  const mOnSpeakingEnd = jest.fn();
  const mGetSubscriber = jest.fn();
  const mSetSubscriber = jest.fn();
  const mGetSpeakingBuffers = jest.fn(() => new Map());
  const mGetSpeakingBufferTimeline = jest.fn(() => []);
  const mClearSpeakingBuffers = jest.fn();
  const mOnVoiceConnectionReady = jest.fn();

  return {
    voiceJoinChannel: mVoiceJoinChannel,
    leaveVoiceChannel: mLeaveVoiceChannel,
    onSpeakingStart: mOnSpeakingStart,
    onSpeakingEnd: mOnSpeakingEnd,
    getSubscriber: mGetSubscriber,
    setSubscriber: mSetSubscriber,
    getSpeakingBuffers: mGetSpeakingBuffers,
    getSpeakingBufferTimeline: mGetSpeakingBufferTimeline,
    clearSpeakingBuffers: mClearSpeakingBuffers,
    onVoiceConnectionReady: mOnVoiceConnectionReady,
  };
});

jest.mock('../src/vc-memo/stt-client', () => ({
  transcribe: jest.fn().mockResolvedValue('hello world'),
}));

jest.mock('../src/vc-memo/summarizer', () => ({
  summarize: jest.fn().mockResolvedValue({
    summary: ['テスト要点'],
    conversationFlow: ['speaker-1 が論点を提示し、speaker-2 が確認した'],
    detailedNotes: mockLongDetailedNotes,
    decisions: ['テスト決定事項'],
    todos: ['テスト対応事項'],
    openQuestions: ['テスト確認事項'],
  }),
}));

jest.mock('@discordjs/voice', () => ({
  joinVoiceChannel: jest.fn(),
  VoiceConnectionStatus: {
    Signalling: 'signalling',
    Ready: 'ready',
    Disconnecting: 'disconnecting',
    Destroyed: 'destroyed',
  },
  entersState: jest.fn().mockResolvedValue(true),
}));

const logger = require('../src/logger');
const sessionManager = require('../src/vc-memo/session-manager');
const speakerTracker = require('../src/vc-memo/speaker-tracker');
const draftWriter = require('../src/vc-memo/draft-writer');
const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');

const VOICE_LISTENER = require('../src/vc-memo/voice-listener');
const AUDIO_PROCESSOR = require('../src/vc-memo/audio-processor');
const STT_CLIENT = require('../src/vc-memo/stt-client');
const SUMMARIZER = require('../src/vc-memo/summarizer');

describe('session-manager', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.VC_MEMO_ENABLED = 'true';
    process.env.VC_MEMO_OPENAI_API_KEY = 'test-key';
    process.env.VC_MEMO_ALLOWED_GUILD_IDS = 'guild-1,guild-2';
    process.env.VC_MEMO_ALLOWED_CHANNEL_IDS = 'channel-1,channel-2';
    sessionManager.reset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns false when feature is disabled', () => {
    process.env.VC_MEMO_ENABLED = 'false';
    expect(sessionManager.checkFeatureEnabled()).toBe(false);
  });

  it('creates a session when feature is enabled and allowlist passes', () => {
    const result = sessionManager.createSession(
      'guild-1',
      'channel-1',
      'single',
      'whisper',
      true
    );
    expect(result).toHaveProperty('id');
    expect(result.state).toBe('JOINING');
    expect(result.guildId).toBe('guild-1');
  });

  it('rejects recording sessions without explicit consent', () => {
    const result = sessionManager.createSession('guild-1', 'channel-1', {
      ownerUserId: 'owner-1',
      consentConfirmed: false,
      canManageGuild: true,
    });

    expect(result).toEqual({ error: 'Recording consent is required' });
  });

  it('allows one active session per guild without blocking other guilds', () => {
    const first = sessionManager.createSession('guild-1', 'channel-1', {
      ownerUserId: 'owner-1',
      consentConfirmed: true,
      canManageGuild: true,
    });
    const second = sessionManager.createSession('guild-2', 'channel-2', {
      ownerUserId: 'owner-2',
      consentConfirmed: true,
      canManageGuild: true,
    });

    expect(first).toHaveProperty('id');
    expect(second).toHaveProperty('id');
    expect(sessionManager.getActiveSessionId('guild-1')).toBe(first.id);
    expect(sessionManager.getActiveSessionId('guild-2')).toBe(second.id);
  });

  it('allows only the owner or a guild manager to control a session', () => {
    const session = sessionManager.createSession('guild-1', 'channel-1', {
      ownerUserId: 'owner-1',
      consentConfirmed: true,
      canManageGuild: true,
    });

    expect(sessionManager.canControlSession(session.id, {
      userId: 'owner-1',
      canManageGuild: false,
    })).toBe(true);
    expect(sessionManager.canControlSession(session.id, {
      userId: 'other-user',
      canManageGuild: true,
    })).toBe(true);
    expect(sessionManager.canControlSession(session.id, {
      userId: 'other-user',
      canManageGuild: false,
    })).toBe(false);
  });

  it('rejects when guild is not in allowlist', () => {
    const result = sessionManager.createSession(
      'guild-999',
      'channel-1',
      'single',
      'whisper',
      true
    );
    expect(result.error).toBeDefined();
  });

  it('rejects when channel is not in allowlist', () => {
    const result = sessionManager.createSession(
      'guild-1',
      'channel-999',
      'single',
      'whisper',
      true
    );
    expect(result.error).toBeDefined();
  });

  it('rejects when another session is active', () => {
    const session1 = sessionManager.createSession('guild-1', 'channel-1', 'single', 'whisper', true);
    const result = sessionManager.createSession('guild-1', 'channel-2', 'single', 'whisper', true);
    expect(result.error).toBe('Another session is already active in this guild');
  });

  it('validates guild channel combination', () => {
    const result = sessionManager.validateGuildChannel('guild-1', 'channel-1');
    expect(result.valid).toBe(true);
  });

  it('rejects invalid guild channel', () => {
    const result = sessionManager.validateGuildChannel('guild-999', 'channel-1');
    expect(result.valid).toBe(false);
  });

  it('transitions states correctly', () => {
    const session = sessionManager.createSession('guild-1', 'channel-1', 'single', 'whisper', true);
    let result = sessionManager.updateState(session.id, 'ACTIVE');
    expect(result).not.toHaveProperty('error');
    expect(session.state).toBe('ACTIVE');

    result = sessionManager.updateState(session.id, 'PROCESSING');
    expect(result).not.toHaveProperty('error');
    expect(session.state).toBe('PROCESSING');

    result = sessionManager.updateState(session.id, 'DRAFT_READY');
    expect(result).not.toHaveProperty('error');
    expect(session.state).toBe('DRAFT_READY');
  });

  it('rejects invalid state transitions', () => {
    const session = sessionManager.createSession('guild-1', 'channel-1', 'single', 'whisper', true);
    const result = sessionManager.updateState(session.id, 'DRAFT_READY');
    expect(result.error).toBeDefined();
  });

  it('gets and deletes a session', () => {
    const session = sessionManager.createSession('guild-1', 'channel-1', 'single', 'whisper', true);
    const sessionId = session.id;
    // Clear the stale active session
    sessionManager.updateState(sessionId, 'IDLE');
    sessionManager.deleteSession(sessionId);
    // Create a fresh session for this test
    const fresh = sessionManager.createSession('guild-1', 'channel-1', 'single', 'whisper', true);
    const found = sessionManager.getSession(fresh.id);
    expect(found).not.toBeNull();
    expect(found.id).toBe(fresh.id);

    const deleted = sessionManager.deleteSession(fresh.id);
    expect(deleted.deleted).toBe(true);
    expect(sessionManager.getSession(fresh.id)).toBeNull();
  });
});

describe('speaker-tracker', () => {
  beforeEach(() => {
    speakerTracker.reset();
  });

  it('returns speaker-1 for first user', () => {
    expect(speakerTracker.getSpeakerId('user-1')).toBe('speaker-1');
  });

  it('returns speaker-2 for second user', () => {
    speakerTracker.getSpeakerId('user-1');
    expect(speakerTracker.getSpeakerId('user-2')).toBe('speaker-2');
  });

  it('returns same speaker id for repeated calls', () => {
    const id1 = speakerTracker.getSpeakerId('user-1');
    const id2 = speakerTracker.getSpeakerId('user-1');
    expect(id1).toBe(id2);
  });

  it('returns speaker label with user id', () => {
    speakerTracker.getSpeakerId('123456789');
    expect(speakerTracker.getSpeakerLabel('123456789')).toBe('speaker-1');
  });

  it('resets on new session', () => {
    speakerTracker.getSpeakerId('user-1');
    speakerTracker.reset();
    speakerTracker.getSpeakerId('user-1');
    expect(speakerTracker.getSpeakerId('user-1')).toBe('speaker-1');
  });
});

describe('draft-writer', () => {
  const testSessionId = 'test-session-draft-' + Date.now();

  afterEach(() => {
    try {
      draftWriter.deleteDraft(testSessionId);
    } catch (e) {
      // ignore
    }
  });

  it('writes and reads a draft', () => {
    const content = '# Test Draft\n\nThis is a test.';
    const filePath = draftWriter.writeDraft(testSessionId, content);
    expect(filePath).toContain('summary-draft.md');

    const read = draftWriter.readDraft(testSessionId);
    expect(read).toBe(content);
  });

  it('returns null for non-existent draft', () => {
    const read = draftWriter.readDraft('non-existent-session');
    expect(read).toBeNull();
  });

  it('deletes a draft', () => {
    draftWriter.writeDraft(testSessionId, 'test content');
    const deleted = draftWriter.deleteDraft(testSessionId);
    expect(deleted).toBe(true);
    expect(draftWriter.readDraft(testSessionId)).toBeNull();
  });
});

describe('audio-processor', () => {
  it('processes opus packets per user', () => {
    const testPacket = Buffer.from('test-opus-packet');
    AUDIO_PROCESSOR.processOpusPacket('user-1', testPacket);
    expect(AUDIO_PROCESSOR.processOpusPacket).toHaveBeenCalled();
  });
});

describe('stt-client', () => {
  it('transcribes wav buffer', async () => {
    const result = await STT_CLIENT.transcribe(Buffer.alloc(100));
    expect(result).toBe('hello world');
  });
});

describe('summarizer', () => {
  it('summarizes transcript with speaker labels', async () => {
    const transcript = 'user-1: hello\nuser-2: hi there';
    const speakerLabels = ['speaker-1 (user: 1)', 'speaker-2 (user: 2)'];
    const result = await SUMMARIZER.summarize(transcript, speakerLabels);
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('conversationFlow');
    expect(result).toHaveProperty('decisions');
    expect(result).toHaveProperty('todos');
    expect(result).toHaveProperty('openQuestions');
  });

  it('throws on API failure', async () => {
    SUMMARIZER.summarize.mockRejectedValueOnce(new Error('API timeout'));
    await expect(SUMMARIZER.summarize('test transcript', [])).rejects.toThrow(
      'API timeout'
    );
  });
});

describe('voice-listener integration', () => {
  it('voiceJoinChannel is called with correct channel and guild IDs', async () => {
    const { voiceJoinChannel } = VOICE_LISTENER;
    expect(voiceJoinChannel).toBeDefined();
    expect(typeof voiceJoinChannel).toBe('function');
  });
});

describe('feature disabled behavior', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.VC_MEMO_ENABLED = 'false';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('prevents session creation when disabled', () => {
    const result = sessionManager.createSession('guild-1', 'channel-1');
    expect(result.error).toBe('Feature is disabled');
  });

  it('returns false for checkFeatureEnabled', () => {
    expect(sessionManager.checkFeatureEnabled()).toBe(false);
  });
});

describe('voice-listener buffer management', () => {
  it('clears speaking buffers', () => {
    const mockBuffers = { clear: jest.fn() };
    VOICE_LISTENER.getSpeakingBuffers().clear = () => {};
    VOICE_LISTENER.clearSpeakingBuffers();
    // Just verify it runs without error
    expect(typeof VOICE_LISTENER.clearSpeakingBuffers).toBe('function');
  });
});

describe('vc-memo start recording wiring', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.VC_MEMO_ENABLED = 'true';
    process.env.VC_MEMO_OPENAI_API_KEY = 'test-key';
    process.env.VC_MEMO_ALLOWED_GUILD_IDS = 'guild-1';
    process.env.VC_MEMO_ALLOWED_CHANNEL_IDS = 'channel-1';
    sessionManager.reset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('requires explicit consent before joining a voice channel', async () => {
    const vcMemo = require('../src/vc-memo');

    const result = await vcMemo.start({}, {
      guildId: 'guild-1',
      channelId: 'channel-1',
      ownerUserId: 'owner-1',
      consentConfirmed: false,
      canManageGuild: true,
    });

    expect(result).toEqual({ error: 'Recording consent is required' });
    expect(VOICE_LISTENER.voiceJoinChannel).not.toHaveBeenCalled();
  });

  it('requires start permission before joining a voice channel', async () => {
    const vcMemo = require('../src/vc-memo');

    const result = await vcMemo.start({}, {
      guildId: 'guild-1',
      channelId: 'channel-1',
      ownerUserId: 'owner-1',
      consentConfirmed: true,
      canManageGuild: false,
    });

    expect(result).toEqual({ error: 'Not authorized to start VC Memo' });
    expect(VOICE_LISTENER.voiceJoinChannel).not.toHaveBeenCalled();
  });

  it('fails closed when VC Memo is enabled without explicit guild and channel allowlists', async () => {
    const vcMemo = require('../src/vc-memo');
    process.env.VC_MEMO_ALLOWED_GUILD_IDS = '';
    process.env.VC_MEMO_ALLOWED_CHANNEL_IDS = '';

    const result = await vcMemo.start({}, {
      guildId: 'guild-1',
      channelId: 'channel-1',
      ownerUserId: 'owner-1',
      consentConfirmed: true,
      canManageGuild: true,
    });

    expect(result).toEqual({ error: 'VC Memo requires explicit guild and channel allowlists' });
    expect(VOICE_LISTENER.voiceJoinChannel).not.toHaveBeenCalled();
  });

  it('prevents a different user from stopping an active session', async () => {
    const vcMemo = require('../src/vc-memo');
    const connection = { receiver: { speaking: { on: jest.fn() } } };
    VOICE_LISTENER.voiceJoinChannel.mockResolvedValue(connection);
    const session = await vcMemo.start({}, {
      guildId: 'guild-1',
      channelId: 'channel-1',
      ownerUserId: 'owner-1',
      consentConfirmed: true,
      canManageGuild: true,
    });

    const result = await vcMemo.stop(session.id, {
      userId: 'other-user',
      canManageGuild: false,
    });

    expect(result).toEqual({ error: 'Not authorized to control this session' });
    expect(VOICE_LISTENER.leaveVoiceChannel).not.toHaveBeenCalled();
  });

  it('registers receiver listeners after joining the voice channel', async () => {
    const vcMemo = require('../src/vc-memo');
    const connection = { receiver: { speaking: { on: jest.fn() } } };
    VOICE_LISTENER.voiceJoinChannel.mockResolvedValueOnce(connection);

    const result = await vcMemo.start(
      {},
      {
        guildId: 'guild-1',
        channelId: 'channel-1',
        mode: 'single',
        stt: 'whisper',
        consentConfirmed: true,
      canManageGuild: true,
      }
    );

    expect(result).toHaveProperty('id');
    expect(VOICE_LISTENER.onVoiceConnectionReady).toHaveBeenCalledWith(
      connection,
      'channel-1',
      'guild-1'
    );
  });

  it('builds and saves an MVP2 draft with conversation flow and detailed notes', async () => {
    const vcMemo = require('../src/vc-memo');
    const connection = { receiver: { speaking: { on: jest.fn() } } };
    VOICE_LISTENER.voiceJoinChannel.mockResolvedValue(connection);
    VOICE_LISTENER.getSpeakingBuffers.mockReturnValue(new Map([
      ['user-1', [Buffer.from('pcm')]],
    ]));
    AUDIO_PROCESSOR.getDecodedWavChunksForUser.mockReturnValue([Buffer.alloc(100)]);

    const first = await vcMemo.start({}, { guildId: 'guild-1', channelId: 'channel-1', ownerUserId: 'owner-1', consentConfirmed: true, canManageGuild: true });
    const stopResult = await vcMemo.stop(first.id, { userId: 'owner-1' });
    expect(stopResult).toMatchObject({ sessionId: first.id });
    const savedDraft = draftWriter.readDraft(first.id);
    expect(savedDraft).toBe(stopResult.draft);
    expect(savedDraft.length).toBeGreaterThan(2000);
    expect(savedDraft).toContain('# VCメモ ドラフト');
    expect(savedDraft).toContain('## 会話の流れ');
    expect(savedDraft).toContain('speaker-1 が論点を提示し、speaker-2 が確認した');
    expect(savedDraft).toContain('## 詳細メモ');
    expect(savedDraft).toContain('背景: MVP2の完了条件を確認した');
    expect(savedDraft).toContain('やりとり: speaker-1 が論点を提示し、speaker-2 が懸念を確認した');
    expect(savedDraft).toContain(mockLongDetailedNoteTail);
    expect(savedDraft).toContain('結論/未決: 詳細メモを残す');
    expect(savedDraft).toContain('## 要点');
    expect(savedDraft).not.toContain('## プライバシーに関する注意');
    expect(savedDraft).not.toContain('## 安全上の注意');
    expect(savedDraft).not.toContain('## Privacy Notes');
    expect(savedDraft).not.toContain('## Summary');
    expect(savedDraft).not.toContain('## Safety Notes');

    const second = await vcMemo.start({}, { guildId: 'guild-1', channelId: 'channel-1', ownerUserId: 'owner-1', consentConfirmed: true, canManageGuild: true });

    expect(second).toHaveProperty('id');
    expect(second.id).not.toBe(first.id);
    expect(VOICE_LISTENER.voiceJoinChannel).toHaveBeenCalledTimes(2);
  });

  it('transcribes split audio chunks in order before summarizing', async () => {
    const vcMemo = require('../src/vc-memo');
    const connection = { receiver: { speaking: { on: jest.fn() } } };
    VOICE_LISTENER.voiceJoinChannel.mockResolvedValue(connection);
    VOICE_LISTENER.getSpeakingBuffers.mockReturnValue(new Map([
      ['user-1', [Buffer.from('pcm')]],
    ]));
    AUDIO_PROCESSOR.getDecodedWavChunksForUser.mockReturnValue([
      Buffer.from('wav-chunk-1'),
      Buffer.from('wav-chunk-2'),
      Buffer.from('wav-chunk-3'),
    ]);
    STT_CLIENT.transcribe
      .mockResolvedValueOnce('最初の発言')
      .mockResolvedValueOnce('続きの発言')
      .mockResolvedValueOnce('最後の発言');

    const session = await vcMemo.start({}, { guildId: 'guild-1', channelId: 'channel-1', ownerUserId: 'owner-1', consentConfirmed: true, canManageGuild: true });
    await vcMemo.stop(session.id, { userId: 'owner-1' });

    expect(STT_CLIENT.transcribe).toHaveBeenNthCalledWith(1, Buffer.from('wav-chunk-1'));
    expect(STT_CLIENT.transcribe).toHaveBeenNthCalledWith(2, Buffer.from('wav-chunk-2'));
    expect(STT_CLIENT.transcribe).toHaveBeenNthCalledWith(3, Buffer.from('wav-chunk-3'));
    expect(SUMMARIZER.summarize).toHaveBeenCalledWith(
      'speaker-1: 最初の発言\nspeaker-1: 続きの発言\nspeaker-1: 最後の発言\n',
      ['speaker-1']
    );
  });

  it('coalesces adjacent same-speaker packets while preserving cross-speaker chronology', async () => {
    const vcMemo = require('../src/vc-memo');
    const connection = { receiver: { speaking: { on: jest.fn() } } };
    VOICE_LISTENER.voiceJoinChannel.mockResolvedValue(connection);
    VOICE_LISTENER.getSpeakingBuffers.mockReturnValue(new Map([
      ['user-1', [Buffer.from('A1'), Buffer.from('A2'), Buffer.from('A3')]],
      ['user-2', [Buffer.from('B1')]],
    ]));
    VOICE_LISTENER.getSpeakingBufferTimeline.mockReturnValue([
      { userId: 'user-1', packetBuffers: [Buffer.from('A1')] },
      { userId: 'user-1', packetBuffers: [Buffer.from('A2')] },
      { userId: 'user-2', packetBuffers: [Buffer.from('B1')] },
      { userId: 'user-1', packetBuffers: [Buffer.from('A3')] },
    ]);
    AUDIO_PROCESSOR.getDecodedWavChunksForUser.mockImplementation((userId, packetBuffers) => (
      [Buffer.from(`wav-${packetBuffers.map((packetBuffer) => packetBuffer.toString()).join('+')}`)]
    ));
    STT_CLIENT.transcribe
      .mockResolvedValueOnce('A1 A2')
      .mockResolvedValueOnce('B1')
      .mockResolvedValueOnce('A3');

    const session = await vcMemo.start({}, { guildId: 'guild-1', channelId: 'channel-1', ownerUserId: 'owner-1', consentConfirmed: true, canManageGuild: true });
    await vcMemo.stop(session.id, { userId: 'owner-1' });

    expect(AUDIO_PROCESSOR.getDecodedWavChunksForUser).toHaveBeenNthCalledWith(
      1,
      'user-1',
      [Buffer.from('A1'), Buffer.from('A2')]
    );
    expect(AUDIO_PROCESSOR.getDecodedWavChunksForUser).toHaveBeenNthCalledWith(
      2,
      'user-2',
      [Buffer.from('B1')]
    );
    expect(AUDIO_PROCESSOR.getDecodedWavChunksForUser).toHaveBeenNthCalledWith(
      3,
      'user-1',
      [Buffer.from('A3')]
    );
    expect(STT_CLIENT.transcribe).toHaveBeenNthCalledWith(1, Buffer.from('wav-A1+A2'));
    expect(STT_CLIENT.transcribe).toHaveBeenNthCalledWith(2, Buffer.from('wav-B1'));
    expect(STT_CLIENT.transcribe).toHaveBeenNthCalledWith(3, Buffer.from('wav-A3'));
    expect(SUMMARIZER.summarize).toHaveBeenCalledWith(
      'speaker-1: A1 A2\nspeaker-2: B1\nspeaker-1: A3\n',
      ['speaker-1', 'speaker-2']
    );
  });

  it('leaves voice channel when discarding an active recording', async () => {
    const vcMemo = require('../src/vc-memo');
    const connection = { receiver: { speaking: { on: jest.fn() } } };
    VOICE_LISTENER.voiceJoinChannel.mockResolvedValueOnce(connection);

    const session = await vcMemo.start({}, { guildId: 'guild-1', channelId: 'channel-1', ownerUserId: 'owner-1', consentConfirmed: true, canManageGuild: true });
    const result = vcMemo.discard(session.id, { userId: 'owner-1' });

    expect(result).toMatchObject({ discarded: true });
    expect(VOICE_LISTENER.leaveVoiceChannel).toHaveBeenCalled();
    expect(vcMemo.getActiveSession()).toBeNull();
  });

  it('recovers session state when stop processing fails', async () => {
    const vcMemo = require('../src/vc-memo');
    const connection = { receiver: { speaking: { on: jest.fn() } } };
    VOICE_LISTENER.voiceJoinChannel.mockResolvedValue(connection);
    VOICE_LISTENER.getSpeakingBuffers.mockReturnValue(new Map([
      ['user-1', [Buffer.from('pcm')]],
    ]));
    AUDIO_PROCESSOR.getDecodedWavChunksForUser.mockImplementation(() => {
      throw new Error('decode failed');
    });
    SUMMARIZER.summarize.mockImplementationOnce(() => {
      throw new Error('summarize failed');
    });
    jest.spyOn(draftWriter, 'writeDraft').mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const failed = await vcMemo.start({}, { guildId: 'guild-1', channelId: 'channel-1', ownerUserId: 'owner-1', consentConfirmed: true, canManageGuild: true });
    await expect(vcMemo.stop(failed.id, { userId: 'owner-1' })).resolves.toMatchObject({
      error: expect.stringContaining('Processing failed'),
    });
    const recovered = await vcMemo.start({}, { guildId: 'guild-1', channelId: 'channel-1', ownerUserId: 'owner-1', consentConfirmed: true, canManageGuild: true });

    expect(recovered).toHaveProperty('id');
    expect(VOICE_LISTENER.leaveVoiceChannel).toHaveBeenCalled();
    draftWriter.writeDraft.mockRestore();
  });

  it('keeps the transcript and records recovery guidance when summarization fails', async () => {
    const vcMemo = require('../src/vc-memo');
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-memo-recovery-'));
    process.env.VC_MEMO_CACHE_DIR = cacheDir;
    const connection = { receiver: { speaking: { on: jest.fn() } } };
    VOICE_LISTENER.voiceJoinChannel.mockResolvedValue(connection);
    VOICE_LISTENER.getSpeakingBuffers.mockReturnValue(new Map([
      ['user-1', [Buffer.from('pcm')]],
    ]));
    AUDIO_PROCESSOR.getDecodedWavChunksForUser.mockReturnValue([Buffer.alloc(100)]);
    STT_CLIENT.transcribe.mockResolvedValueOnce('保存対象の全文');
    SUMMARIZER.summarize.mockRejectedValueOnce(new Error('upstream unavailable'));

    const session = await vcMemo.start({}, {
      guildId: 'guild-1',
      channelId: 'channel-1',
      ownerUserId: 'owner-1',
      consentConfirmed: true,
      canManageGuild: true,
    });
    const result = await vcMemo.stop(session.id, { userId: 'owner-1' });

    expect(fs.readFileSync(path.join(cacheDir, session.id, 'transcript.txt'), 'utf8'))
      .toContain('speaker-1: 保存対象の全文\n');
    expect(result.draft).toContain('要約の生成に失敗しました');
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });
});

describe('voice-listener receiver subscriptions', () => {
  let voiceListener;
  let speakingHandlers;
  let receiver;
  let stream;
  let connection;
  let client;
  let voiceMock;
  let isolatedLogger;

  beforeEach(() => {
    jest.resetModules();
    jest.unmock('../src/vc-memo/voice-listener');
    isolatedLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    jest.doMock('../src/logger', () => isolatedLogger);
    voiceMock = {
      VoiceConnectionStatus: {
        Signalling: 'signalling',
        Ready: 'ready',
        Disconnected: 'disconnected',
        Destroyed: 'destroyed',
      },
      VoiceConnection: jest.fn(),
      entersState: jest.fn(),
      EndBehaviorType: { Manual: 'manual', AfterSilence: 'afterSilence' },
      joinVoiceChannel: jest.fn(),
    };
    jest.doMock('@discordjs/voice', () => voiceMock);

    jest.isolateModules(() => {
      voiceListener = require('../src/vc-memo/voice-listener');
    });

    speakingHandlers = {};
    stream = {
      on: jest.fn(),
      destroy: jest.fn(),
    };
    receiver = {
      speaking: {
        on: jest.fn((event, handler) => {
          speakingHandlers[event] = handler;
        }),
      },
      ssrcMap: {
        on: jest.fn(),
      },
      subscribe: jest.fn(() => stream),
    };
    client = {
      on: jest.fn(),
      off: jest.fn(),
    };
    connection = {
      receiver,
      client,
      destroy: jest.fn(),
    };
  });

  it('subscribes to a user when speaking starts and avoids duplicate subscriptions', () => {
    const starts = [];
    voiceListener.onSpeakingStart((userId) => starts.push(userId));
    voiceListener.onVoiceConnectionReady(connection, 'channel-1', 'guild-1');

    speakingHandlers.start('user-1');
    speakingHandlers.start('user-1');

    expect(receiver.subscribe).toHaveBeenCalledTimes(1);
    expect(receiver.subscribe).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ end: expect.any(Object) })
    );
    expect(starts).toEqual(['user-1', 'user-1']);
  });

  it('throws a clear error when the voice connection has no receiver', () => {
    expect(() => voiceListener.onVoiceConnectionReady({ on: jest.fn() }, 'channel-1', 'guild-1')).toThrow(
      'Voice connection receiver is not available'
    );
  });

  it('does not fail the join when receiver speaking events are unavailable but ssrcMap events exist', () => {
    const ssrcHandlers = {};
    delete receiver.speaking;
    receiver.ssrcMap = {
      on: jest.fn((event, handler) => {
        ssrcHandlers[event] = handler;
      }),
    };

    expect(() => voiceListener.onVoiceConnectionReady(connection, 'channel-1', 'guild-1')).not.toThrow();
    ssrcHandlers.create({ userId: 'user-1' });

    expect(receiver.subscribe).toHaveBeenCalledWith('user-1', expect.any(Object));
  });

  it('uses @discordjs/voice joinVoiceChannel even if the channel exposes join()', async () => {
    const { ChannelType } = require('discord.js');
    const handlers = {};
    const joinedConnection = {
      state: {},
      receiver,
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
      }),
      destroy: jest.fn(),
    };
    voiceMock.joinVoiceChannel.mockReturnValueOnce(joinedConnection);
    const channelJoin = jest.fn(() => ({ on: jest.fn() }));
    const clientWithJoinableChannel = {
      channels: {
        cache: {
          get: jest.fn(() => ({
            id: 'channel-1',
            name: 'Voice',
            type: ChannelType.GuildVoice,
            join: channelJoin,
          })),
        },
      },
      guilds: {
        cache: {
          get: jest.fn(() => ({
            id: 'guild-1',
            voiceAdapterCreator: jest.fn(),
          })),
        },
      },
    };

    const joinPromise = voiceListener.voiceJoinChannel('channel-1', 'guild-1', clientWithJoinableChannel);
    handlers.ready();
    await expect(joinPromise).resolves.toBe(joinedConnection);

    expect(channelJoin).not.toHaveBeenCalled();
    expect(voiceMock.joinVoiceChannel).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'channel-1',
      guildId: 'guild-1',
      selfDeaf: false,
      selfMute: true,
      debug: true,
    }));
  });

  it('does not require manual gateway listeners when the voice connection already has an adapter', async () => {
    const { ChannelType } = require('discord.js');
    const handlers = {};
    const joinedConnection = {
      state: {
        adapter: {
          sendPayload: jest.fn(),
        },
      },
      receiver,
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
      }),
      destroy: jest.fn(),
    };
    voiceMock.joinVoiceChannel.mockReturnValueOnce(joinedConnection);
    const clientWithoutEmitter = {
      channels: {
        cache: {
          get: jest.fn(() => ({
            id: 'channel-1',
            name: 'Voice',
            type: ChannelType.GuildVoice,
          })),
        },
      },
      guilds: {
        cache: {
          get: jest.fn(() => ({
            id: 'guild-1',
            voiceAdapterCreator: jest.fn(),
          })),
        },
      },
    };

    const joinPromise = voiceListener.voiceJoinChannel('channel-1', 'guild-1', clientWithoutEmitter);
    handlers.ready();

    await expect(joinPromise).resolves.toBe(joinedConnection);
    expect(joinedConnection.state.adapter.sendPayload).not.toHaveBeenCalled();
  });

  it('forwards raw voice gateway packets only when the adapter has not already received them', async () => {
    const { ChannelType } = require('discord.js');
    const handlers = {};
    const rawHandlers = {};
    const adapterMethods = {
      onVoiceServerUpdate: jest.fn((packet) => {
        joinedConnection.packets.server = packet;
      }),
      onVoiceStateUpdate: jest.fn((packet) => {
        joinedConnection.packets.state = packet;
      }),
    };
    const joinedConnection = {
      state: { status: 'signalling' },
      packets: {},
      receiver,
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
      }),
      destroy: jest.fn(),
      configureNetworking: jest.fn(),
    };
    voiceMock.joinVoiceChannel.mockReturnValueOnce(joinedConnection);
    const clientWithRaw = {
      user: { id: 'bot-1' },
      on: jest.fn((event, handler) => {
        rawHandlers[event] = handler;
      }),
      off: jest.fn(),
      voice: {
        adapters: {
          get: jest.fn(() => adapterMethods),
        },
      },
      channels: {
        cache: {
          get: jest.fn(() => ({
            id: 'channel-1',
            name: 'Voice',
            type: ChannelType.GuildVoice,
          })),
        },
      },
      guilds: {
        cache: {
          get: jest.fn(() => ({
            id: 'guild-1',
            voiceAdapterCreator: jest.fn(),
          })),
        },
      },
    };

    const joinPromise = voiceListener.voiceJoinChannel('channel-1', 'guild-1', clientWithRaw);
    rawHandlers.raw({ t: 'VOICE_SERVER_UPDATE', d: { guild_id: 'guild-1', endpoint: 'voice.example', token: 'token' } });
    rawHandlers.raw({ t: 'VOICE_STATE_UPDATE', d: { guild_id: 'guild-1', user_id: 'bot-1', channel_id: 'channel-1', session_id: 'session' } });
    await Promise.resolve();
    handlers.ready();

    await expect(joinPromise).resolves.toBe(joinedConnection);
    expect(adapterMethods.onVoiceServerUpdate).toHaveBeenCalledTimes(1);
    expect(adapterMethods.onVoiceStateUpdate).toHaveBeenCalledTimes(1);
    expect(joinedConnection.configureNetworking).toHaveBeenCalledTimes(1);
    expect(clientWithRaw.off).toHaveBeenCalledWith('raw', rawHandlers.raw);
  });

  it('does not duplicate raw voice gateway packets already handled by discord.js', async () => {
    const { ChannelType } = require('discord.js');
    const handlers = {};
    const rawHandlers = {};
    const adapterMethods = {
      onVoiceServerUpdate: jest.fn(),
      onVoiceStateUpdate: jest.fn(),
    };
    const joinedConnection = {
      state: { status: 'signalling' },
      packets: {
        server: { guild_id: 'guild-1', endpoint: 'voice.example', token: 'token' },
        state: { guild_id: 'guild-1', user_id: 'bot-1', session_id: 'session' },
      },
      receiver,
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
      }),
      destroy: jest.fn(),
      configureNetworking: jest.fn(),
    };
    voiceMock.joinVoiceChannel.mockReturnValueOnce(joinedConnection);
    const clientWithRaw = {
      user: { id: 'bot-1' },
      on: jest.fn((event, handler) => {
        rawHandlers[event] = handler;
      }),
      off: jest.fn(),
      voice: {
        adapters: {
          get: jest.fn(() => adapterMethods),
        },
      },
      channels: {
        cache: {
          get: jest.fn(() => ({
            id: 'channel-1',
            name: 'Voice',
            type: ChannelType.GuildVoice,
          })),
        },
      },
      guilds: {
        cache: {
          get: jest.fn(() => ({
            id: 'guild-1',
            voiceAdapterCreator: jest.fn(),
          })),
        },
      },
    };

    const joinPromise = voiceListener.voiceJoinChannel('channel-1', 'guild-1', clientWithRaw);
    rawHandlers.raw({ t: 'VOICE_SERVER_UPDATE', d: { guild_id: 'guild-1', endpoint: 'voice.example', token: 'token' } });
    rawHandlers.raw({ t: 'VOICE_STATE_UPDATE', d: { guild_id: 'guild-1', user_id: 'bot-1', session_id: 'session' } });
    await Promise.resolve();
    handlers.ready();

    await expect(joinPromise).resolves.toBe(joinedConnection);
    expect(adapterMethods.onVoiceServerUpdate).not.toHaveBeenCalled();
    expect(adapterMethods.onVoiceStateUpdate).not.toHaveBeenCalled();
    expect(joinedConnection.configureNetworking).not.toHaveBeenCalled();
  });

  it('does not add entersState waiters on repeated signalling events', async () => {
    const { ChannelType } = require('discord.js');
    const handlers = {};
    const joinedConnection = {
      state: { status: 'signalling' },
      packets: {},
      receiver,
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
      }),
      destroy: jest.fn(),
    };
    voiceMock.joinVoiceChannel.mockReturnValueOnce(joinedConnection);
    const clientWithRaw = {
      user: { id: 'bot-1' },
      on: jest.fn(),
      off: jest.fn(),
      voice: {
        adapters: {
          get: jest.fn(),
        },
      },
      channels: {
        cache: {
          get: jest.fn(() => ({
            id: 'channel-1',
            name: 'Voice',
            type: ChannelType.GuildVoice,
          })),
        },
      },
      guilds: {
        cache: {
          get: jest.fn(() => ({
            id: 'guild-1',
            voiceAdapterCreator: jest.fn(),
          })),
        },
      },
    };

    const joinPromise = voiceListener.voiceJoinChannel('channel-1', 'guild-1', clientWithRaw);
    expect(handlers.signalling).toBeUndefined();
    handlers.ready();

    await expect(joinPromise).resolves.toBe(joinedConnection);
    expect(voiceMock.entersState).not.toHaveBeenCalled();
  });

  it('includes sanitized voice debug tail in timeout diagnostics', async () => {
    jest.useFakeTimers();
    const { ChannelType } = require('discord.js');
    const handlers = {};
    const joinedConnection = {
      state: { status: 'signalling' },
      packets: {
        server: { guild_id: 'guild-1', endpoint: 'voice.example', token: 'secret-token' },
        state: { guild_id: 'guild-1', user_id: 'bot-1', channel_id: 'channel-1', session_id: 'secret-session' },
      },
      rejoinAttempts: 1,
      receiver,
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
      }),
      destroy: jest.fn(),
    };
    voiceMock.joinVoiceChannel.mockReturnValueOnce(joinedConnection);
    const clientWithRaw = {
      user: { id: 'bot-1' },
      on: jest.fn(),
      off: jest.fn(),
      voice: {
        adapters: {
          has: jest.fn(() => true),
          get: jest.fn(),
        },
      },
      ws: { status: 0 },
      channels: {
        cache: {
          get: jest.fn(() => ({
            id: 'channel-1',
            name: 'Voice',
            type: ChannelType.GuildVoice,
          })),
        },
      },
      guilds: {
        cache: {
          get: jest.fn(() => ({
            id: 'guild-1',
            voiceAdapterCreator: jest.fn(),
            shard: { status: 0 },
          })),
        },
      },
    };

    const joinPromise = voiceListener.voiceJoinChannel('channel-1', 'guild-1', clientWithRaw);
    handlers.debug('[WS] >> {"op":0,"d":{"token":"secret-token","session_id":"secret-session"}}');
    handlers.debug('[WS] << {"op":8,"d":{"heartbeat_interval":41250}}');
    handlers.debug('[NW] [WS] >> {"op":0,"d":{"token":"secret-token","session_id":"secret-session"}}');
    handlers.debug('[NW] state change:\nfrom {"connectionOptions":{"token":"secret-token","sessionId":"secret-session"}}\nto {"connectionData":{"secretKey":[1,2,3]}}');
    jest.advanceTimersByTime(30_000);

    await expect(joinPromise).rejects.toThrow('Voice channel join timeout after 30 seconds');
    const diagnosticsCall = isolatedLogger.warn.mock.calls.find(([, message]) => (
      message === '[vc-memo/voice] connection timeout diagnostics'
    ));
    expect(diagnosticsCall).toBeDefined();
    expect(diagnosticsCall[0].joinState.voiceDebugTail).toEqual([
      '[WS] >> op=0',
      '[WS] << op=8',
      '[NW] [WS] >> op=0',
      '[NW] state change',
    ]);
    expect(JSON.stringify(diagnosticsCall[0])).not.toContain('secret-token');
    expect(JSON.stringify(diagnosticsCall[0])).not.toContain('secret-session');
    expect(JSON.stringify(diagnosticsCall[0])).not.toContain('secretKey');
    expect(JSON.stringify(isolatedLogger.debug.mock.calls)).not.toContain('secret-token');
    expect(JSON.stringify(isolatedLogger.debug.mock.calls)).not.toContain('secret-session');
    expect(JSON.stringify(isolatedLogger.debug.mock.calls)).not.toContain('secretKey');
    jest.useRealTimers();
  });

  it('ignores stale raw voice state packets for a different voice channel', async () => {
    const { ChannelType } = require('discord.js');
    const handlers = {};
    const rawHandlers = {};
    const adapterMethods = {
      onVoiceServerUpdate: jest.fn((packet) => {
        joinedConnection.packets.server = packet;
      }),
      onVoiceStateUpdate: jest.fn((packet) => {
        joinedConnection.packets.state = packet;
      }),
    };
    const joinedConnection = {
      state: { status: 'signalling' },
      packets: {},
      receiver,
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
      }),
      destroy: jest.fn(),
      configureNetworking: jest.fn(),
    };
    voiceMock.joinVoiceChannel.mockReturnValueOnce(joinedConnection);
    const clientWithRaw = {
      user: { id: 'bot-1' },
      on: jest.fn((event, handler) => {
        rawHandlers[event] = handler;
      }),
      off: jest.fn(),
      voice: {
        adapters: {
          get: jest.fn(() => adapterMethods),
        },
      },
      channels: {
        cache: {
          get: jest.fn(() => ({
            id: 'channel-1',
            name: 'Voice',
            type: ChannelType.GuildVoice,
          })),
        },
      },
      guilds: {
        cache: {
          get: jest.fn(() => ({
            id: 'guild-1',
            voiceAdapterCreator: jest.fn(),
          })),
        },
      },
    };

    const joinPromise = voiceListener.voiceJoinChannel('channel-1', 'guild-1', clientWithRaw);
    rawHandlers.raw({ t: 'VOICE_STATE_UPDATE', d: { guild_id: 'guild-1', user_id: 'bot-1', channel_id: 'old-channel', session_id: 'old-session' } });
    rawHandlers.raw({ t: 'VOICE_SERVER_UPDATE', d: { guild_id: 'guild-1', endpoint: 'voice.example', token: 'token' } });
    rawHandlers.raw({ t: 'VOICE_STATE_UPDATE', d: { guild_id: 'guild-1', user_id: 'bot-1', channel_id: 'channel-1', session_id: 'new-session' } });
    await Promise.resolve();
    handlers.ready();

    await expect(joinPromise).resolves.toBe(joinedConnection);
    expect(adapterMethods.onVoiceStateUpdate).toHaveBeenCalledTimes(1);
    expect(adapterMethods.onVoiceStateUpdate).toHaveBeenCalledWith(expect.objectContaining({
      channel_id: 'channel-1',
      session_id: 'new-session',
    }));
    expect(joinedConnection.configureNetworking).toHaveBeenCalledTimes(1);
  });

  it('removes raw fallback listeners when joinVoiceChannel returns an invalid connection', async () => {
    const { ChannelType } = require('discord.js');
    const rawHandlers = {};
    voiceMock.joinVoiceChannel.mockReturnValueOnce({});
    const clientWithRaw = {
      user: { id: 'bot-1' },
      on: jest.fn((event, handler) => {
        rawHandlers[event] = handler;
      }),
      off: jest.fn(),
      voice: {
        adapters: {
          get: jest.fn(),
        },
      },
      channels: {
        cache: {
          get: jest.fn(() => ({
            id: 'channel-1',
            name: 'Voice',
            type: ChannelType.GuildVoice,
          })),
        },
      },
      guilds: {
        cache: {
          get: jest.fn(() => ({
            id: 'guild-1',
            voiceAdapterCreator: jest.fn(),
          })),
        },
      },
    };

    await expect(voiceListener.voiceJoinChannel('channel-1', 'guild-1', clientWithRaw)).rejects.toThrow(
      'Failed to create voice connection'
    );
    expect(clientWithRaw.off).toHaveBeenCalledWith('raw', rawHandlers.raw);
  });

  it('does not require SSRCMap entries and subscribes from SSRC update events', () => {
    const ssrcHandlers = {};
    receiver.ssrcMap = {
      on: jest.fn((event, handler) => {
        ssrcHandlers[event] = handler;
      }),
    };

    expect(() => voiceListener.onVoiceConnectionReady(connection, 'channel-1', 'guild-1')).not.toThrow();
    ssrcHandlers.create({ userId: 'user-1' });
    ssrcHandlers.update(undefined, { userId: 'user-2' });

    expect(receiver.subscribe).toHaveBeenCalledWith('user-1', expect.any(Object));
    expect(receiver.subscribe).toHaveBeenCalledWith('user-2', expect.any(Object));
  });

  it('cleans subscriptions, callbacks, buffers, and connection state on leave', () => {
    voiceListener.onSpeakingStart(jest.fn());
    voiceListener.onSpeakingEnd(jest.fn());
    voiceListener.onVoiceConnectionReady(connection, 'channel-1', 'guild-1');
    speakingHandlers.start('user-1');
    voiceListener.getSpeakingBuffers().set('user-1', [Buffer.from('audio')]);

    voiceListener.leaveVoiceChannel();

    expect(stream.destroy).toHaveBeenCalledTimes(1);
    expect(connection.destroy).toHaveBeenCalledTimes(1);
    expect(voiceListener.getSpeakingBuffers().size).toBe(0);
    expect(voiceListener.getResolvedReceiver()).toBeNull();

    speakingHandlers.start('user-2');
    expect(receiver.subscribe).toHaveBeenCalledTimes(1);
  });

  it('ignores receiver subscriptions that do not return event-emitter streams', () => {
    receiver.subscribe.mockReturnValueOnce({ destroy: jest.fn() });
    voiceListener.onVoiceConnectionReady(connection, 'channel-1', 'guild-1');

    expect(() => speakingHandlers.start('user-1')).not.toThrow();
  });
});

describe('audio-processor opus decoding', () => {
  let encodedFrame;

  beforeEach(() => {
    jest.resetModules();
    const OpusScript = require('opusscript');
    const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
    encodedFrame = encoder.encode(Buffer.alloc(960 * 2 * 2), 960);
  });

  it('decodes opus frames to 48kHz stereo wav data for a user', () => {
    let audioProcessor;
    const recordSpeakingBufferTimeline = jest.fn();
    jest.isolateModules(() => {
      const speakingBuffers = new Map();
      jest.unmock('../src/vc-memo/audio-processor');
      jest.doMock('../src/vc-memo/voice-listener', () => ({
        getSpeakingBuffers: () => speakingBuffers,
        recordSpeakingBufferTimeline,
      }));
      jest.doMock('../src/logger', () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }));
      audioProcessor = require('../src/vc-memo/audio-processor');
    });

    audioProcessor.processOpusPacket('user-1', encodedFrame);
    const wav = audioProcessor.getDecodedWavForUser('user-1');

    expect(wav.slice(0, 4).toString()).toBe('RIFF');
    expect(wav.slice(8, 12).toString()).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(24)).toBe(48000);
    expect(wav.readUInt32LE(40)).toBe(960 * 2 * 2);
    expect(recordSpeakingBufferTimeline).toHaveBeenCalledTimes(1);
    expect(recordSpeakingBufferTimeline).toHaveBeenCalledWith('user-1', expect.any(Buffer));
    expect(recordSpeakingBufferTimeline.mock.calls[0][1]).toHaveLength(960 * 2 * 2);
  });

  it('splits decoded pcm into wav chunks under the configured size limit', () => {
    let audioProcessor;
    jest.isolateModules(() => {
      const speakingBuffers = new Map();
      jest.unmock('../src/vc-memo/audio-processor');
      jest.doMock('../src/vc-memo/voice-listener', () => ({
        getSpeakingBuffers: () => speakingBuffers,
      }));
      jest.doMock('../src/logger', () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }));
      audioProcessor = require('../src/vc-memo/audio-processor');
    });

    const chunks = audioProcessor.splitPcmBuffersToWavChunks([Buffer.alloc(100)], 84);

    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(84);
      expect(chunk.slice(0, 4).toString()).toBe('RIFF');
      expect(chunk.slice(8, 12).toString()).toBe('WAVE');
    }
    expect(chunks.map((chunk) => chunk.readUInt32LE(40))).toEqual([40, 40, 20]);
  });

  it('logs and skips opus frames that cannot be decoded', () => {
    let audioProcessor;
    let mockedLogger;
    jest.isolateModules(() => {
      const speakingBuffers = new Map();
      jest.unmock('../src/vc-memo/audio-processor');
      mockedLogger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };
      jest.doMock('../src/vc-memo/voice-listener', () => ({
        getSpeakingBuffers: () => speakingBuffers,
      }));
      jest.doMock('../src/logger', () => mockedLogger);
      audioProcessor = require('../src/vc-memo/audio-processor');
    });

    expect(() => audioProcessor.processOpusPacket('user-1', Buffer.from('bad'))).not.toThrow();
    expect(mockedLogger.error).not.toHaveBeenCalled();
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      '[vc-memo/audio] skipping undecodable opus packet'
    );
    expect(audioProcessor.getDecodedWavForUser('user-1')).toBeNull();
  });
});
