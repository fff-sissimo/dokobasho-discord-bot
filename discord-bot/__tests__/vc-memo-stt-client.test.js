jest.mock('../src/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('vc-memo stt-client', () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    jest.resetModules();
    jest.clearAllMocks();
  });

  function mockSuccessfulFetch(text = 'こんにちは') {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ text }),
    });
  }

  it('sends Japanese as the default transcription language', async () => {
    process.env = {
      ...originalEnv,
      VC_MEMO_OPENAI_API_KEY: 'test-key',
    };
    delete process.env.VC_MEMO_STT_LANGUAGE;
    mockSuccessfulFetch();

    const sttClient = require('../src/vc-memo/stt-client');
    const result = await sttClient.transcribe(Buffer.alloc(100), 1);

    expect(result).toBe('こんにちは');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [, options] = global.fetch.mock.calls[0];
    expect(options.body.get('model')).toBe('whisper-1');
    expect(options.body.get('language')).toBe('ja');
  });

  it('allows the transcription language to be overridden', async () => {
    process.env = {
      ...originalEnv,
      VC_MEMO_OPENAI_API_KEY: 'test-key',
      VC_MEMO_STT_LANGUAGE: 'en',
    };
    mockSuccessfulFetch('hello');

    const sttClient = require('../src/vc-memo/stt-client');
    const result = await sttClient.transcribe(Buffer.alloc(100), 1);

    expect(result).toBe('hello');

    const [, options] = global.fetch.mock.calls[0];
    expect(options.body.get('language')).toBe('en');
  });

  it('passes an AbortSignal and does not retry non-retryable 4xx responses', async () => {
    process.env = { ...originalEnv, VC_MEMO_OPENAI_API_KEY: 'test-key' };
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: jest.fn().mockResolvedValue('sensitive upstream detail'),
    });
    const sttClient = require('../src/vc-memo/stt-client');

    await expect(sttClient.transcribe(Buffer.alloc(10), {
      retries: 3,
      timeoutMs: 50,
      fetchImpl,
      retryDelayMs: 0,
    })).rejects.toThrow('Transcription request failed (status 400)');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    await expect(sttClient.transcribe(Buffer.alloc(10), {
      retries: 1,
      fetchImpl,
    })).rejects.not.toThrow('sensitive upstream detail');
  });
});
