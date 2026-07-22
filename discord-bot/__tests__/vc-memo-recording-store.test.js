const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRecordingStore } = require('../src/vc-memo/recording-store');

describe('VC Memo recording store', () => {
  let rootDir;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-memo-store-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('appends PCM to disk and exposes bounded WAV chunks', () => {
    const store = createRecordingStore({ rootDir, sessionId: 'session-1' });

    for (let index = 0; index < 100; index += 1) {
      store.appendPcm('user/1', Buffer.alloc(40, index));
    }

    expect(store.listUsers()).toEqual(['user/1']);
    expect(fs.statSync(store.getPcmPath('user/1')).size).toBe(4000);
    expect(fs.existsSync(path.join(store.sessionDir, 'manifest.jsonl'))).toBe(true);

    const chunks = [...store.readWavChunks('user/1', 844)];
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 844)).toBe(true);
    expect(chunks.every((chunk) => chunk.subarray(0, 4).toString() === 'RIFF')).toBe(true);
  });

  it('persists the full transcript independently from the draft', () => {
    const store = createRecordingStore({ rootDir, sessionId: 'session-2' });

    store.writeTranscript('speaker-1: 復旧可能な全文\n');

    expect(store.readTranscript()).toBe('speaker-1: 復旧可能な全文\n');
    expect(fs.readFileSync(path.join(store.sessionDir, 'transcript.txt'), 'utf8'))
      .toBe('speaker-1: 復旧可能な全文\n');
  });

  it('rejects PCM appends that would exceed the session byte limit', () => {
    const store = createRecordingStore({
      rootDir,
      sessionId: 'session-limited',
      maxSessionBytes: 10,
    });

    store.appendPcm('user-1', Buffer.alloc(8));

    expect(() => store.appendPcm('user-1', Buffer.alloc(4))).toThrow('VC Memo session byte limit exceeded');
    expect(fs.statSync(store.getPcmPath('user-1')).size).toBe(8);
  });

  it('routes decoded audio to disk without retaining PCM in speaking buffers', () => {
    const store = createRecordingStore({ rootDir, sessionId: 'session-3' });
    const speakingBuffers = new Map();
    let audioProcessor;
    jest.isolateModules(() => {
      jest.doMock('../src/vc-memo/voice-listener', () => ({
        getSpeakingBuffers: () => speakingBuffers,
        recordSpeakingBufferTimeline: jest.fn(),
      }));
      audioProcessor = require('../src/vc-memo/audio-processor');
    });
    const OpusScript = require('opusscript');
    const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
    const encodedFrame = encoder.encode(Buffer.alloc(960 * 2 * 2), 960);

    audioProcessor.setRecordingStore('guild-1', store);
    for (let index = 0; index < 20; index += 1) {
      audioProcessor.processOpusPacket('user-1', encodedFrame, { guildId: 'guild-1' });
    }

    expect(speakingBuffers.size).toBe(0);
    expect(fs.statSync(store.getPcmPath('user-1')).size).toBe(20 * 960 * 2 * 2);
  });
});
