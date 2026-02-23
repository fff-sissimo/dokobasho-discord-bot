const {
  buildFallbackFirstReplyMessage,
  normalizeFirstReplyForDiscord,
  createOpenAiFirstReplyComposer,
} = require("../src/fairy-first-reply-ai");

describe("fairy first reply ai", () => {
  it("builds fallback first reply", () => {
    const content = buildFallbackFirstReplyMessage("一次回答を確認して？");
    expect(content).toContain("一次回答を確認して");
    expect(content).toContain("まず文脈と関連情報を整理して");
    expect(content).toContain("少し待ってください");
    expect(content).not.toContain("Request:");
    expect(content).not.toContain("進捗:");
    expect(content).not.toContain("方針:");
  });

  it("normalizes generated content and strips metadata lines", () => {
    const normalized = normalizeFirstReplyForDiscord(
      ["対応を開始します。", "Request: RQ-1 / 進捗: 準備中", "少し待ってください。"].join("\n"),
      "fallback"
    );
    expect(normalized).toContain("対応を開始します。 少し待ってください。");
    expect(normalized).toContain("まず文脈と関連情報を整理して");
    expect(normalized).not.toContain("方針:");
  });

  it("calls responses API and returns output_text", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ output_text: "了解しました。内容を確認して進めます。少し待ってください。" }),
    });
    const compose = createOpenAiFirstReplyComposer({
      apiKey: "test-key",
      fetchImpl,
    });

    const content = await compose({
      invocationMessage: "テスト",
      contextExcerpt: [],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(content).toContain("少し待ってください");
  });

  it("falls back to chat completions when responses API fails", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => '{"error":{"message":"not found"}}',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "了解しました。確認して進めます。少し待ってください。" } }],
        }),
      });

    const compose = createOpenAiFirstReplyComposer({
      apiKey: "test-key",
      model: "gpt-4.1-mini",
      modelFallbacks: [],
      fetchImpl,
    });

    const content = await compose({
      invocationMessage: "チャット補完フォールバック確認",
      contextExcerpt: [],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toContain("/v1/responses");
    expect(fetchImpl.mock.calls[1][0]).toContain("/v1/chat/completions");
    expect(content).toContain("少し待ってください");
  });
});
