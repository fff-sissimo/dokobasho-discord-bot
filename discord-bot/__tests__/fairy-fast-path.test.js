const mockAckByRoute = Object.freeze({
  slash_command: "-# 受け付けたよ。内容を確認して返すね。",
  mention: "-# 呼んでくれてありがとう。内容を確認して返すね。",
  reply: "-# 返信ありがとう。内容を確認して返すね。",
});

jest.mock("../src/fairy-core-adapter", () => ({
  fairyCoreAdapter: {
    buildFallbackFirstReplyMessage: (_message, route = "slash_command") => mockAckByRoute[route],
    normalizeFirstReplyForDiscord: (_raw, fallback) => fallback,
    assertSlowPathJobPayloadContract: () => {},
    SLOW_PATH_PAYLOAD_SCHEMA_VERSION: "3",
    SLOW_PATH_TRIGGER_SOURCES: ["slash_command", "mention", "reply"],
  },
}));

const {
  FAIRY_COMMAND_NAME,
  generateRequestId,
  buildFirstReplyMessage,
  collectFastPathContext,
  createFairyInteractionHandler,
  createFairyMessageHandler,
  normalizeReplyAntecedentContent,
  normalizeReplyAntecedentEntry,
} = require("../src/fairy-fast-path");

describe("fairy fast path", () => {
  it("generates deterministic request id shape", () => {
    const date = new Date("2026-02-23T12:34:56.789Z");
    const id = generateRequestId(date, () => "12345678-90ab-cdef-1111-222233334444");
    expect(id).toBe("RQ-20260223-123456789-1234567890ab");
  });

  it("builds concise first reply message without progress metadata", () => {
    const message = buildFirstReplyMessage("確認して？");
    expect(message).toBe(mockAckByRoute.slash_command);
  });

  it("builds route-aware first reply message", () => {
    expect(buildFirstReplyMessage("確認して？", "mention")).toBe(mockAckByRoute.mention);
    expect(buildFirstReplyMessage("確認して？", "reply")).toBe(mockAckByRoute.reply);
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
      contextEntriesSource: async () => [
        {
          message_id: "msg_ctx_001",
          author_user_id: "user_123",
          author_is_bot: false,
          content: "latest context",
        },
      ],
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
    expect(result.firstReplySource).toBe("fallback");
    expect(result.firstReplyError).toBeUndefined();
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: false });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: mockAckByRoute.slash_command,
      })
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        schema_version: "3",
        request_id: "RQ-20260223-000000000-aaaaaaaaaaaa",
        command_name: "fairy",
        trigger_source: "slash_command",
        source_message_id: null,
        context_excerpt: ["latest context", "another line"],
        context_entries: [
          {
            message_id: "msg_ctx_001",
            author_user_id: "user_123",
            author_is_bot: false,
            content: "latest context",
          },
        ],
        first_reply_message_id: null,
      })
    );
    expect(enqueue.mock.calls[0][0].reply_antecedent_entry).toBeUndefined();
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

  it("always returns fixed first reply", async () => {
    const enqueue = jest.fn().mockResolvedValue({ status: 200 });
    const handler = createFairyInteractionHandler({
      slowPathClient: { enqueue },
      contextSource: async () => ["ctx"],
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
    expect(result.firstReplyError).toBeUndefined();
    expect(firstContent).toBe(mockAckByRoute.slash_command);
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
      contextEntriesSource: async () => [
        {
          message_id: "msg_ctx_002",
          author_user_id: "user_msg_001",
          author_is_bot: false,
          content: "msg-context-1",
        },
        {
          message_id: "msg_ctx_003",
          author_user_id: "bot_001",
          author_is_bot: true,
          content: "bot-context",
        },
      ],
      requestIdFactory: () => "RQ-20260223-000000000-eeeeeeeeeeee",
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
    expect(result.firstReplySource).toBe("fallback");
    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: mockAckByRoute.mention,
      })
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        schema_version: "3",
        request_id: "RQ-20260223-000000000-eeeeeeeeeeee",
        event_id: "msg_001",
        trigger_source: "mention",
        source_message_id: "msg_001",
        user_id: "user_msg_001",
        command_name: "fairy",
        invocation_message: "テストして",
        first_reply_message_id: "msg_reply_001",
        context_entries: [
          {
            message_id: "msg_ctx_002",
            author_user_id: "user_msg_001",
            author_is_bot: false,
            content: "msg-context-1",
          },
        ],
      })
    );
    expect(enqueue.mock.calls[0][0].reply_antecedent_entry).toBeUndefined();
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

  it("includes reply_antecedent_entry for mention+reply when available", async () => {
    const enqueue = jest.fn().mockResolvedValue({ status: 200 });
    const handler = createFairyMessageHandler({
      slowPathClient: { enqueue },
      contextSource: async () => ["現在の文脈"],
      requestIdFactory: () => "RQ-20260223-000000000-111111111111",
      enqueueAttempts: 1,
    });

    const message = {
      id: "msg_mention_reply_001",
      content: "<@1100870989518213200> これを見て",
      createdAt: new Date("2026-02-23T12:02:00.000Z"),
      channelId: "723456789012345678",
      guildId: "823456789012345678",
      author: { id: "user_msg_003", bot: false },
      client: {
        user: { id: "1100870989518213200" },
        application: { id: "app_msg_003" },
      },
      reply: jest.fn().mockResolvedValue({ id: "msg_reply_003", edit: jest.fn().mockResolvedValue(undefined) }),
    };

    const result = await handler(message, {
      messageTriggerSource: "mention",
      sourceMessageId: "msg_mention_reply_001",
      replyAntecedentEntry: {
        message_id: "msg_anchor_001",
        author_user_id: "user_anchor_001",
        author_is_bot: false,
        content: "元メッセージの内容",
      },
    });

    expect(result.handled).toBe(true);
    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: mockAckByRoute.mention,
      })
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        schema_version: "3",
        trigger_source: "mention",
        source_message_id: "msg_mention_reply_001",
        reply_antecedent_entry: {
          message_id: "msg_anchor_001",
          author_user_id: "user_anchor_001",
          author_is_bot: false,
          content: "元メッセージの内容",
        },
      })
    );
  });

  it("normalizes reply antecedent content into a single line with cap", () => {
    const value = normalizeReplyAntecedentContent(`長文\tテスト\n${"a".repeat(7000)}`);
    expect(value.includes("\n")).toBe(false);
    expect(value.includes("\t")).toBe(false);
    expect(value.startsWith("長文 テスト")).toBe(true);
    expect(value.length).toBe(6000);
  });

  it("rejects malformed reply antecedent entries before enqueue", async () => {
    const enqueue = jest.fn().mockResolvedValue({ status: 200 });
    const edit = jest.fn().mockResolvedValue(undefined);
    const handler = createFairyMessageHandler({
      slowPathClient: { enqueue },
      contextSource: async () => ["現在の文脈"],
      requestIdFactory: () => "RQ-20260223-000000000-222222222222",
      enqueueAttempts: 1,
    });

    const message = {
      id: "msg_invalid_antecedent_001",
      content: "<@1100870989518213200> これを見て",
      createdAt: new Date("2026-02-23T12:03:00.000Z"),
      channelId: "723456789012345678",
      guildId: "823456789012345678",
      author: { id: "user_msg_004", bot: false },
      client: {
        user: { id: "1100870989518213200" },
        application: { id: "app_msg_004" },
      },
      reply: jest.fn().mockResolvedValue({ id: "msg_reply_004", edit }),
    };

    const result = await handler(message, {
      messageTriggerSource: "mention",
      sourceMessageId: "msg_invalid_antecedent_001",
      replyAntecedentEntry: {
        message_id: "msg_anchor_invalid_001",
        author_user_id: "",
        author_is_bot: false,
        content: "元メッセージの内容",
      },
    });

    expect(result.handled).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("slow-path payload contract failed"),
      })
    );
    expect(edit).not.toHaveBeenCalled();
  });

  it("normalizes reply antecedent entries before payload assembly", () => {
    expect(
      normalizeReplyAntecedentEntry({
        message_id: " msg_anchor_002 ",
        author_user_id: " user_anchor_002 ",
        author_is_bot: true,
        content: "  元メッセージ\nの内容  ",
      })
    ).toEqual({
      message_id: "msg_anchor_002",
      author_user_id: "user_anchor_002",
      author_is_bot: true,
      content: "元メッセージ の内容",
    });
  });

  it("rejects reply antecedent entries whose author_is_bot is not boolean", () => {
    expect(() =>
      normalizeReplyAntecedentEntry({
        message_id: "msg_anchor_003",
        author_user_id: "user_anchor_003",
        author_is_bot: "false",
        content: "元メッセージの内容",
      })
    ).toThrow("author_is_bot");
  });
});
