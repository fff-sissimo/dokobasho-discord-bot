const {
  FAIRY_COMMAND_NAME,
  generateRequestId,
  buildFirstReplyMessage,
  collectFastPathContext,
  createFairyInteractionHandler,
} = require("../src/fairy-fast-path");

describe("fairy fast path", () => {
  it("generates deterministic request id shape", () => {
    const date = new Date("2026-02-23T12:34:56.789Z");
    const id = generateRequestId(date, () => "12345678-90ab-cdef-1111-222233334444");
    expect(id).toBe("RQ-20260223-123456789-1234567890ab");
  });

  it("builds first reply message with progress marker", () => {
    const message = buildFirstReplyMessage("確認して？", "RQ-20260223-000000000-aaaaaaaaaaaa");
    expect(message).toContain("了解、いま確認中なので待ってて。");
    expect(message).toContain("Request: RQ-20260223-000000000-aaaaaaaaaaaa / 進捗: 準備中");
    expect(message.includes("？")).toBe(false);
  });

  it("collects context with char cap truncation", () => {
    const context = collectFastPathContext({
      recentMessages: ["  abc  ", "defgh"],
      caps: {
        maxMessages: 20,
        maxLinks: 0,
        maxChars: 5,
        collectionDeadlineMs: 1200,
      },
      now: () => 0,
      startedAtMs: 0,
    });
    expect(context.messages).toEqual(["abc", "de"]);
    expect(context.totalChars).toBe(5);
    expect(context.truncated).toBe(true);
  });

  it("handles /fairy and enqueues slow path payload", async () => {
    const enqueue = jest.fn().mockResolvedValue({ status: 200 });
    const handler = createFairyInteractionHandler({
      slowPathClient: { enqueue },
      contextSource: async () => ["latest context", "another line"],
      requestIdFactory: () => "RQ-20260223-000000000-aaaaaaaaaaaa",
      enqueueAttempts: 1,
    });

    const interaction = {
      isChatInputCommand: () => true,
      commandName: FAIRY_COMMAND_NAME,
      id: "evt_123",
      token: "token_123",
      applicationId: "app_123",
      user: { id: "user_123" },
      channelId: "123456789012345678",
      guildId: "223456789012345678",
      options: {
        getString: jest.fn().mockImplementation((name) => (name === "request" ? "調査して？" : null)),
      },
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
    };

    const result = await handler(interaction);

    expect(result.handled).toBe(true);
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: false });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Request: RQ-20260223-000000000-aaaaaaaaaaaa / 進捗: 準備中"),
      })
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: "RQ-20260223-000000000-aaaaaaaaaaaa",
        command_name: "fairy",
        context_excerpt: ["latest context", "another line"],
      })
    );
  });

  it("updates first reply when enqueue fails", async () => {
    const handler = createFairyInteractionHandler({
      slowPathClient: { enqueue: jest.fn().mockRejectedValue(new Error("enqueue down")) },
      contextSource: async () => ["ctx"],
      requestIdFactory: () => "RQ-20260223-000000000-bbbbbbbbbbbb",
      enqueueAttempts: 1,
    });

    const interaction = {
      isChatInputCommand: () => true,
      commandName: FAIRY_COMMAND_NAME,
      id: "evt_456",
      token: "token_456",
      applicationId: "app_456",
      user: { id: "user_456" },
      channelId: "323456789012345678",
      guildId: null,
      options: { getString: () => "テスト依頼" },
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
    };

    const result = await handler(interaction);
    const contents = interaction.editReply.mock.calls.map((args) => args[0].content);

    expect(result.handled).toBe(true);
    expect(result.enqueueError).toContain("enqueue down");
    expect(contents[1]).toContain("後続処理の投入に失敗したため自動処理を開始できませんでした。");
  });
});
