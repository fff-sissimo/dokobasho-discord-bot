const {
  FAIRY_COMMAND_NAME,
  generateRequestId,
  buildFirstReplyMessage,
  collectFastPathContext,
  createFairyInteractionHandler,
  createFairyMessageHandler,
} = require("../src/fairy-fast-path");

describe("fairy fast path", () => {
  it("generates deterministic request id shape", () => {
    const date = new Date("2026-02-23T12:34:56.789Z");
    const id = generateRequestId(date, () => "12345678-90ab-cdef-1111-222233334444");
    expect(id).toBe("RQ-20260223-123456789-1234567890ab");
  });

  it("builds concise first reply message without progress metadata", () => {
    const message = buildFirstReplyMessage("確認して？");
    expect(message).toContain("ちょっと待っててね");
    expect(message).toContain("まず文脈と関連情報を整理して");
    expect(message).toContain("返すね");
    expect(message).not.toContain("Request:");
    expect(message).not.toContain("進捗:");
    expect(message).not.toContain("方針:");
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
      firstReplyComposer: async () =>
        [
          "対応を開始します。",
          "Request: RQ-20260223-000000000-aaaaaaaaaaaa / 進捗: 準備中",
          "少し待ってください。",
        ].join("\n"),
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
    expect(result.firstReplySource).toBe("ai");
    expect(result.firstReplyError).toBeUndefined();
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: false });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("対応を開始します。 少し待ってください。 まず文脈と関連情報を整理して、要点からわかりやすく返すね。"),
      })
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: "RQ-20260223-000000000-aaaaaaaaaaaa",
        command_name: "fairy",
        trigger_source: "slash_command",
        source_message_id: null,
        context_excerpt: ["latest context", "another line"],
        first_reply_message_id: null,
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
    expect(result.firstReplySource).toBe("fallback");
    expect(result.enqueueError).toContain("enqueue down");
    expect(contents[1]).toContain("後続処理の投入に失敗したため自動処理を開始できませんでした。");
  });

  it("falls back when first reply composer fails", async () => {
    const enqueue = jest.fn().mockResolvedValue({ status: 200 });
    const handler = createFairyInteractionHandler({
      slowPathClient: { enqueue },
      contextSource: async () => ["ctx"],
      firstReplyComposer: async () => {
        throw new Error("openai unavailable");
      },
      requestIdFactory: () => "RQ-20260223-000000000-cccccccccccc",
      enqueueAttempts: 1,
    });

    const interaction = {
      isChatInputCommand: () => true,
      commandName: FAIRY_COMMAND_NAME,
      id: "evt_789",
      token: "token_789",
      applicationId: "app_789",
      user: { id: "user_789" },
      channelId: "423456789012345678",
      guildId: null,
      options: { getString: () => "テスト依頼" },
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
    };

    const result = await handler(interaction);
    const firstContent = interaction.editReply.mock.calls[0][0].content;

    expect(result.handled).toBe(true);
    expect(result.firstReplySource).toBe("fallback");
    expect(result.firstReplyError).toContain("openai unavailable");
    expect(firstContent).toContain("ちょっと待っててね");
    expect(firstContent).toContain("まず文脈と関連情報を整理して");
    expect(firstContent).not.toContain("Request:");
    expect(firstContent).not.toContain("進捗:");
    expect(firstContent).not.toContain("方針:");
  });

  it("stores first reply message id in slow-path payload when available", async () => {
    const enqueue = jest.fn().mockResolvedValue({ status: 200 });
    const handler = createFairyInteractionHandler({
      slowPathClient: { enqueue },
      requestIdFactory: () => "RQ-20260223-000000000-dddddddddddd",
      enqueueAttempts: 1,
    });
    const interaction = {
      isChatInputCommand: () => true,
      commandName: FAIRY_COMMAND_NAME,
      id: "evt_msgid_001",
      token: "token_msgid_001",
      applicationId: "app_msgid_001",
      user: { id: "user_msgid_001" },
      channelId: "523456789012345678",
      guildId: "623456789012345678",
      options: { getString: () => "メッセージID検証" },
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue({ id: "112233445566778899" }),
    };

    const result = await handler(interaction);

    expect(result.handled).toBe(true);
    expect(result.firstReplySource).toBe("fallback");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].first_reply_message_id).toBe("112233445566778899");
  });

  it("handles mention message and enqueues slow path payload", async () => {
    const enqueue = jest.fn().mockResolvedValue({ status: 200 });
    const replyEdit = jest.fn().mockResolvedValue(undefined);
    const handler = createFairyMessageHandler({
      slowPathClient: { enqueue },
      contextSource: async () => ["msg-context-1", "msg-context-2"],
      requestIdFactory: () => "RQ-20260223-000000000-eeeeeeeeeeee",
      firstReplyComposer: async () => "了解だよ。まず整理してから、要点をわかりやすく返すね。ちょっと待っててね。",
      enqueueAttempts: 1,
    });

    const message = {
      id: "msg_001",
      content: "<@1100870989518213200> テストして？",
      createdAt: new Date("2026-02-23T12:00:00.000Z"),
      channelId: "723456789012345678",
      guildId: "823456789012345678",
      author: { id: "user_msg_001", bot: false },
      client: {
        user: { id: "1100870989518213200" },
        application: { id: "app_msg_001" },
      },
      reply: jest.fn().mockResolvedValue({ id: "msg_reply_001", edit: replyEdit }),
    };

    const result = await handler(message);

    expect(result.handled).toBe(true);
    expect(result.firstReplySource).toBe("ai");
    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("ちょっと待っててね"),
      })
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: "RQ-20260223-000000000-eeeeeeeeeeee",
        event_id: "msg_001",
        trigger_source: "mention",
        source_message_id: "msg_001",
        user_id: "user_msg_001",
        command_name: "fairy",
        invocation_message: "テストして",
        first_reply_message_id: "msg_reply_001",
      })
    );
  });

  it("handles reply message trigger source metadata", async () => {
    const enqueue = jest.fn().mockResolvedValue({ status: 200 });
    const handler = createFairyMessageHandler({
      slowPathClient: { enqueue },
      contextSource: async () => ["msg-context-reply"],
      requestIdFactory: () => "RQ-20260223-000000000-ffffffffffff",
      enqueueAttempts: 1,
    });

    const message = {
      id: "msg_002",
      content: "追加で教えて",
      createdAt: new Date("2026-02-23T12:01:00.000Z"),
      channelId: "723456789012345678",
      guildId: "823456789012345678",
      author: { id: "user_msg_002", bot: false },
      client: {
        user: { id: "1100870989518213200" },
        application: { id: "app_msg_002" },
      },
      reply: jest.fn().mockResolvedValue({ id: "msg_reply_002", edit: jest.fn().mockResolvedValue(undefined) }),
    };

    const result = await handler(message, {
      messageTriggerSource: "reply",
      sourceMessageId: "msg_source_reply_002",
    });

    expect(result.handled).toBe(true);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: "RQ-20260223-000000000-ffffffffffff",
        trigger_source: "reply",
        source_message_id: "msg_source_reply_002",
        first_reply_message_id: "msg_reply_002",
      })
    );
  });
});
