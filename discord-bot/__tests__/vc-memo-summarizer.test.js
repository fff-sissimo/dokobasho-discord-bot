jest.mock('../src/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('vc-memo summarizer', () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('requests Japanese detailed notes with a chronological conversation flow', async () => {
    process.env = {
      ...originalEnv,
      VC_MEMO_OPENAI_API_KEY: 'test-key',
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: ['主要論点'],
                conversationFlow: ['speaker-1 が背景を説明した'],
                detailedNotes: ['背景: 導入の目的を確認した。やりとり: speaker-1 が前提を説明した。結論/未決: 次回確認する。'],
                decisions: [],
                todos: [],
                openQuestions: [],
              }),
            },
          },
        ],
      }),
    });

    const summarizer = require('../src/vc-memo/summarizer');
    const result = await summarizer.summarize('speaker-1: 背景を説明しました', ['speaker-1']);

    expect(result).toHaveProperty('conversationFlow');
    expect(result.conversationFlow).toEqual(['speaker-1 が背景を説明した']);
    expect(result).toHaveProperty('detailedNotes');
    expect(result.detailedNotes).toEqual([
      '背景: 導入の目的を確認した。やりとり: speaker-1 が前提を説明した。結論/未決: 次回確認する。',
    ]);

    const [, options] = global.fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    const systemPrompt = body.messages[0].content;

    for (const keyword of [
      '"conversationFlow"',
      '"detailedNotes"',
      '日本語',
      '詳細メモ',
      '背景',
      'やりとり',
      '結論/未決',
      '時系列',
    ]) {
      expect(systemPrompt).toContain(keyword);
    }
    expect(systemPrompt).toMatch(/短く.*(圧縮|し).*すぎ/);
  });

  it('splits long transcripts into bounded requests and attaches timeout signals', async () => {
    process.env = { ...originalEnv, VC_MEMO_OPENAI_API_KEY: 'test-key' };
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ summary: ['部分要約'] }) } }],
      }),
    });
    const summarizer = require('../src/vc-memo/summarizer');

    const result = await summarizer.summarize('あ'.repeat(55), ['speaker-1'], {
      maxChunkChars: 20,
      timeoutMs: 100,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [, options] of fetchImpl.mock.calls) {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(options.body);
      const userMessage = body.messages[1].content;
      expect(userMessage.slice(userMessage.indexOf('--- TRANSCRIPT ---') + 18).trim().length)
        .toBeLessThanOrEqual(20);
    }
    expect(result.summary).toEqual(['部分要約', '部分要約', '部分要約']);
  });

  it('does not expose upstream response bodies in errors', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: jest.fn().mockResolvedValue('sensitive upstream detail'),
    });
    const summarizer = require('../src/vc-memo/summarizer');

    await expect(summarizer.summarize('text', [], { fetchImpl }))
      .rejects.toThrow('Summarization request failed (status 503)');
    await expect(summarizer.summarize('text', [], { fetchImpl }))
      .rejects.not.toThrow('sensitive upstream detail');
  });
});
