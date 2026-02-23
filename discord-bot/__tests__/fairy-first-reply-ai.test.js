const {
  buildFallbackFirstReplyMessage,
  normalizeFirstReplyForDiscord,
  createOpenAiFirstReplyComposer,
} = require("../src/fairy-first-reply-ai");

describe("fairy first reply ai", () => {
  it("builds fallback first reply", () => {
    const content = buildFallbackFirstReplyMessage("一次回答を確認して？");
    expect(content).toContain("一次回答を確認して");
    expect(content).toContain("少し待ってください");
    expect(content).not.toContain("Request:");
    expect(content).not.toContain("進捗:");
  });

  it("normalizes generated content and strips metadata lines", () => {
    const normalized = normalizeFirstReplyForDiscord(
      ["対応を開始します。", "Request: RQ-1 / 進捗: 準備中", "少し待ってください。"].join("\n"),
      "fallback"
    );
    expect(normalized).toBe("対応を開始します。 少し待ってください。");
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
});
